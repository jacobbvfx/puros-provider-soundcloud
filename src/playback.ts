import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_SESSION_ID_PATTERN,
  ProviderApiError,
  type FormatInfoV1,
  type PlaybackArtifactV1,
  type PlaybackResolveRequestV1,
  type ProviderHostV1,
} from 'puros-provider-sdk'
import { apiError, type SoundCloudClient } from './api'
import type { SoundCloudCatalog } from './catalog'
import { probeDurationMs, remuxM4a } from './ffmpeg'
import { requireTrackId } from './ids'
import { asNumber, asRecord, asString } from './json'
import { downloadFile, downloadHls, type MediaProgress } from './media'
import type { SoundCloudSession } from './session'
import { playableTranscodings, sniffContainer, unavailableError, type Transcoding } from './streams'

/** Bump when the preparation pipeline changes so older cache entries are not reused. */
export const PREPARATION_REVISION = 1
const AUDIO_DIR = 'audio'
const WORK_DIR = 'work'
const MAX_CONCURRENT = 2
const MAX_ATTEMPTS = 3
const DURATION_TOLERANCE_MS = 2_000
/** Originals are the artist's file, not SoundCloud's transcode of it: allow a little more difference. */
const ORIGINAL_DURATION_TOLERANCE_MS = 5_000
const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE'])
/** Containers of original uploads that core plays directly. */
const ORIGINAL_FORMATS = new Set(['FLAC', 'FLAC_HIRES', 'ALAC', 'AIFF', 'WAV', 'MP3', 'AAC'])

export type AudioSource = 'stream' | 'original'

type Host = Pick<ProviderHostV1, 'paths' | 'cache' | 'helpers' | 'logger' | 'catalog'> & { events: Pick<ProviderHostV1['events'], 'emit'> }
type Intent = 'playback' | 'prefetch'

export interface PlaybackDeps {
  host: Host
  session: Pick<SoundCloudSession, 'accountKey' | 'getToken'>
  client: Pick<SoundCloudClient, 'request'>
  catalog: Pick<SoundCloudCatalog, 'getTrackObject'>
  audioSource(): Promise<AudioSource>
  fetch?: typeof fetch
  remux?: typeof remuxM4a
  probe?: typeof probeDurationMs
  sleep?: (ms: number) => Promise<void>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

interface Job {
  key: string
  sourceId: string
  intent: Intent
  abort: AbortController
  sessions: Set<string>
  done: ReturnType<typeof deferred<PlaybackArtifactV1>>
  revision: number
}

interface Context { source: AudioSource; qualityKey: string; account: string }

function errorCode(error: unknown): string {
  return error instanceof ProviderApiError ? error.providerError.code : 'INTERNAL'
}

const cancelled = () => apiError('CANCELLED', 'SoundCloud download cancelled', true)

/** Strict v1 fields only (host values may carry extra members). */
export function plainFormat(format: FormatInfoV1): FormatInfoV1 {
  return {
    format: format.format,
    sampleRate: format.sampleRate,
    bitDepth: format.bitDepth,
    bitrate: Number.isFinite(format.bitrate) ? Math.round(format.bitrate) : 0,
    channels: format.channels,
    isLossless: format.isLossless,
    isHiRes: format.isHiRes,
    isMqa: format.isMqa,
    isDsd: format.isDsd,
  }
}

/** A lossy stream at its decode rate: no source bit depth, never lossless or Hi-Res. Bitrate in kb/s. */
export function lossyFormat(codec: 'AAC' | 'MP3', input: { sampleRate: number; channels: number; bitrateKbps: number }): FormatInfoV1 {
  return {
    format: codec,
    sampleRate: Math.round(input.sampleRate),
    bitDepth: 0,
    bitrate: Math.max(0, Math.round(input.bitrateKbps)),
    channels: Math.max(0, Math.round(input.channels)),
    isLossless: false,
    isHiRes: false,
    isMqa: false,
    isDsd: false,
  }
}

const EXTENSIONS: Record<string, string> = { FLAC: 'flac', FLAC_HIRES: 'flac', ALAC: 'm4a', AIFF: 'aiff', WAV: 'wav', MP3: 'mp3', AAC: 'm4a' }

/**
 * SoundCloud audio → verified file artifact in the provider cache.
 *
 * Streams: the best playable transcoding is downloaded as it is (progressive
 * MP3 as one file, HLS segments concatenated in order); fragmented-MP4 AAC is
 * stream-copied into a plain M4A by ffmpeg. Originals (opt-in): the artist's
 * download file when it is a container core plays directly, else the stream.
 * Either way the artifact is reported `complete` only after it decoded end to
 * end at the length SoundCloud states. Single flight per track, at most two
 * downloads at a time, playback ahead of prefetch.
 */
export class SoundCloudPlayback {
  private readonly jobs = new Map<string, Job>()
  private readonly sessions = new Map<string, Job>()
  private readonly queue: Array<{ job: Job; start: () => void }> = []
  private running = 0
  private active = true
  private readonly remux: typeof remuxM4a
  private readonly probe: typeof probeDurationMs
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: PlaybackDeps) {
    this.remux = deps.remux ?? remuxM4a
    this.probe = deps.probe ?? probeDurationMs
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private get host() { return this.deps.host }

  /** Drop intermediates of a run that crashed or was killed. */
  async cleanupStaleFiles(): Promise<void> {
    const root = await this.host.paths.getCacheRoot()
    await fs.rm(path.join(root, WORK_DIR), { recursive: true, force: true }).catch(() => {})
    const entries = await fs.readdir(path.join(root, AUDIO_DIR), { recursive: true, withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith('.tmp-'))
      .map((entry) => fs.rm(path.join(entry.parentPath, entry.name), { force: true }).catch(() => {})))
  }

  async resolve(request: PlaybackResolveRequestV1): Promise<PlaybackArtifactV1> {
    const context = await this.context(request.sourceId)
    const cached = await this.cached(request.sourceId, context.qualityKey)
    if (cached) return cached
    const sessionId = request.sessionId && PROVIDER_SESSION_ID_PATTERN.test(request.sessionId) ? request.sessionId : undefined
    return this.join(request.sourceId, context, request.intent, sessionId).done.promise
  }

  async prefetch(request: Omit<PlaybackResolveRequestV1, 'intent'>): Promise<PlaybackArtifactV1 | null> {
    try {
      return await this.resolve({ ...request, intent: 'prefetch', sessionId: undefined })
    } catch (error) {
      if (errorCode(error) !== 'CANCELLED') {
        await this.host.logger.info('SoundCloud prefetch skipped', { sourceId: request.sourceId, code: errorCode(error) }).catch(() => {})
      }
      return null
    }
  }

  /** Cancel the work a caller session waits on; shared work stops once nobody waits. */
  async cancelSession(sessionId: string): Promise<boolean> {
    const job = this.sessions.get(sessionId)
    if (!job) return false
    this.sessions.delete(sessionId)
    job.sessions.delete(sessionId)
    if (job.sessions.size === 0 && job.intent === 'playback') job.abort.abort()
    return true
  }

  async cancelAll(): Promise<void> {
    for (const job of this.jobs.values()) job.abort.abort()
    for (const { job } of this.queue.splice(0)) {
      job.done.reject(cancelled())
      this.jobs.delete(job.key)
    }
  }

  async shutdown(): Promise<void> {
    this.active = false
    await this.cancelAll()
  }

  busy(): boolean { return this.jobs.size > 0 }

  // ---- context and cache ----

  private async context(sourceId: string): Promise<Context> {
    if (!this.active) throw apiError('PROVIDER_UNAVAILABLE', 'SoundCloud provider is inactive', true)
    requireTrackId(sourceId)
    const source = await this.deps.audioSource()
    const account = this.deps.session.accountKey()
    return { source, account, qualityKey: `${source}-r${PREPARATION_REVISION}-${account}` }
  }

  private async cached(sourceId: string, qualityKey: string): Promise<PlaybackArtifactV1 | null> {
    const cached = await this.host.cache.get({ sourceId, qualityKey })
    if (!cached || cached.resolvedSourceId !== sourceId) return null
    return { path: cached.path, lifecycle: 'complete', format: plainFormat(cached.format) }
  }

  // ---- scheduling ----

  private join(sourceId: string, context: Context, intent: Intent, sessionId: string | undefined): Job {
    const key = `${context.qualityKey}:${sourceId}`
    const existing = this.jobs.get(key)
    const job: Job = existing ?? { key, sourceId, intent, abort: new AbortController(), sessions: new Set(), done: deferred(), revision: 0 }
    if (sessionId) {
      job.sessions.add(sessionId)
      this.sessions.set(sessionId, job)
    }
    if (!existing) {
      this.jobs.set(key, job)
      this.queue.push({ job, start: () => {
        void this.run(job, context).finally(() => {
          if (this.jobs.get(key) === job) this.jobs.delete(key)
          for (const session of job.sessions) if (this.sessions.get(session) === job) this.sessions.delete(session)
          this.running -= 1
          this.pump()
        })
      } })
      this.sortQueue()
      this.pump()
    } else if (intent === 'playback' && job.intent === 'prefetch') {
      job.intent = 'playback'
      this.sortQueue()
    }
    return job
  }

  private sortQueue(): void {
    const rank = (entry: { job: Job }) => (entry.job.intent === 'playback' ? 0 : 1)
    this.queue.sort((a, b) => rank(a) - rank(b))
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift()!
      if (next.job.abort.signal.aborted) {
        next.job.done.reject(cancelled())
        this.jobs.delete(next.job.key)
        continue
      }
      this.running += 1
      next.start()
    }
  }

  private progress(job: Job, startedAt: number) {
    let last = 0
    return (progress: MediaProgress, state: 'running' | 'completed' = 'running') => {
      const target = [...job.sessions][0]
      const now = Date.now()
      if (!target || (state === 'running' && now - last < 250)) return
      last = now
      job.revision += 1
      const percent = state === 'completed' ? 100
        : progress.itemsTotal ? Math.min(99, (progress.items ?? 0) / progress.itemsTotal * 100)
          : progress.totalBytes ? Math.min(99, progress.bytes / progress.totalBytes * 100) : null
      void this.host.events.emit({
        type: 'playback.progress',
        progress: {
          sessionId: target,
          sourceId: job.sourceId,
          state,
          bytesCompleted: progress.bytes,
          bytesTotal: progress.totalBytes,
          ...(progress.itemsTotal ? { itemsCompleted: progress.items ?? 0, itemsTotal: progress.itemsTotal } : {}),
          percent,
          bytesPerSecond: Math.round(progress.bytes / Math.max(1, now - startedAt) * 1000),
          estimatedRemainingMs: null,
          playbackStarted: false,
          revision: job.revision,
        },
      }).catch(() => {})
    }
  }

  // ---- the download ----

  private async run(job: Job, context: Context): Promise<void> {
    const signal = job.abort.signal
    const cacheRoot = await this.host.paths.getCacheRoot()
    const workDirectory = path.join(cacheRoot, WORK_DIR, randomUUID())
    const audioDirectory = path.join(cacheRoot, AUDIO_DIR, context.account)
    const report = this.progress(job, Date.now())
    let outcome: { ok: true; artifact: PlaybackArtifactV1 } | { ok: false; error: unknown }
    try {
      await fs.mkdir(workDirectory, { recursive: true, mode: 0o700 })
      await fs.mkdir(audioDirectory, { recursive: true })
      const again = await this.cached(job.sourceId, context.qualityKey)
      if (again) {
        outcome = { ok: true, artifact: again }
        return
      }
      const prepared = await this.withRetries(job, async (attempt) => {
        const attemptDirectory = path.join(workDirectory, `attempt-${attempt}`)
        await fs.mkdir(attemptDirectory, { recursive: true, mode: 0o700 })
        const track = await this.deps.catalog.getTrackObject(job.sourceId, signal)
        if (context.source === 'original') {
          const original = await this.tryOriginal(job, track, attemptDirectory, audioDirectory, signal, report)
          if (original) return original
        }
        return this.prepareStream(job, track, attemptDirectory, audioDirectory, signal, report)
      })
      await this.host.cache.put({
        sourceId: job.sourceId,
        qualityKey: context.qualityKey,
        path: prepared.artifact.path,
        format: prepared.artifact.format,
        resolvedSourceId: job.sourceId,
        resolvedQuality: prepared.quality,
      })
      await this.host.cache.trim().catch(() => {})
      await this.host.catalog.updateTrackFormat({ sourceId: job.sourceId, format: prepared.artifact.format }).catch(() => {})
      report({ bytes: 1, totalBytes: 1 }, 'completed')
      outcome = { ok: true, artifact: prepared.artifact }
    } catch (error) {
      outcome = { ok: false, error: signal.aborted && errorCode(error) !== 'CANCELLED' ? cancelled() : error }
    } finally {
      // Intermediates are gone before anyone sees the result.
      await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => {})
      if (outcome!.ok) job.done.resolve(outcome!.artifact)
      else job.done.reject(outcome!.error)
    }
  }

  /** Transient failures (an expired media URL, a dropped connection, rate limiting) get a fresh stream address. */
  private async withRetries<T>(job: Job, task: (attempt: number) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      if (job.abort.signal.aborted) throw cancelled()
      try {
        return await task(attempt)
      } catch (error) {
        const code = errorCode(error)
        if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS || job.abort.signal.aborted) throw error
        await this.host.logger.warn('SoundCloud download failed; retrying', { sourceId: job.sourceId, code, attempt }).catch(() => {})
        await this.sleep(code === 'RATE_LIMITED' ? 5_000 * attempt : 1_000 * attempt)
      }
    }
  }

  /** The best playable transcoding, falling through to the next one when SoundCloud no longer has a variant. */
  private async prepareStream(job: Job, track: unknown, work: string, audioDirectory: string, signal: AbortSignal, report: (progress: MediaProgress) => void) {
    const { transcodings, reason } = playableTranscodings(track)
    if (transcodings.length === 0) throw unavailableError(reason)
    const authorization = asString(asRecord(track)?.track_authorization) ?? undefined
    const expectedMs = asNumber(asRecord(track)?.full_duration) ?? asNumber(asRecord(track)?.duration)
    let lastError: unknown = null
    for (const transcoding of transcodings) {
      try {
        return await this.downloadTranscoding(job, transcoding, authorization, transcoding.durationMs ?? expectedMs, work, audioDirectory, signal, report)
      } catch (error) {
        if (!['NOT_FOUND', 'NOT_SUPPORTED'].includes(errorCode(error))) throw error
        lastError = error
      }
    }
    throw lastError
  }

  private async downloadTranscoding(
    job: Job, transcoding: Transcoding, authorization: string | undefined, expectedMs: number | null,
    work: string, audioDirectory: string, signal: AbortSignal, report: (progress: MediaProgress) => void,
  ): Promise<{ artifact: PlaybackArtifactV1; quality: string }> {
    const answer = asRecord(await this.deps.client.request({
      path: transcoding.url,
      query: authorization ? { track_authorization: authorization } : undefined,
      auth: 'optional',
      signal,
    }))
    const mediaUrl = asString(answer?.url)
    if (!mediaUrl || !mediaUrl.startsWith('https://')) throw apiError('NOT_FOUND', 'SoundCloud returned no stream address for this format')
    const media = { fetch: this.deps.fetch, signal, onProgress: report }
    const final = path.join(audioDirectory, `${job.sourceId}.${transcoding.preset}.r${PREPARATION_REVISION}.${transcoding.codec === 'AAC' ? 'm4a' : 'mp3'}`)
    const temporary = path.join(audioDirectory, `.tmp-${job.sourceId}.${randomUUID()}.${transcoding.codec === 'AAC' ? 'm4a' : 'mp3'}`)
    try {
      if (transcoding.codec === 'MP3') {
        // MP3 progressive is one file; MP3 HLS segments are plain MPEG frames whose concatenation is the same stream.
        if (transcoding.protocol === 'progressive') await downloadFile(mediaUrl, temporary, media)
        else if ((await downloadHls(mediaUrl, temporary, media)).fragmentedMp4) throw apiError('NOT_SUPPORTED', 'SoundCloud packaged this MP3 stream unexpectedly')
      } else {
        const downloaded = path.join(work, `stream.${transcoding.protocol === 'hls' ? 'mp4' : 'm4a'}`)
        if (transcoding.protocol === 'progressive') await downloadFile(mediaUrl, downloaded, media)
        else await downloadHls(mediaUrl, downloaded, media)
        await this.remux(this.host.helpers, downloaded, temporary, signal)
      }
      const inspected = await this.verify(temporary, expectedMs, DURATION_TOLERANCE_MS, signal)
      if (inspected.format !== transcoding.codec) throw apiError('INTERNAL', `The prepared file is ${inspected.format}, not ${transcoding.codec}`)
      const format = lossyFormat(transcoding.codec, { sampleRate: inspected.sampleRate, channels: inspected.channels, bitrateKbps: transcoding.bitrateKbps })
      await fs.rename(temporary, final)
      return { artifact: { path: final, lifecycle: 'complete', format }, quality: `stream-${transcoding.preset}${transcoding.premium ? '-hq' : ''}` }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  /**
   * The artist's original file, when they allow downloads and it is a format
   * core plays directly. Any other outcome (no downloads left, an unsupported
   * container, a failed check) falls back to the stream; only cancellation and
   * session failures propagate.
   */
  private async tryOriginal(job: Job, track: unknown, work: string, audioDirectory: string, signal: AbortSignal, report: (progress: MediaProgress) => void) {
    const record = asRecord(track)
    if (!this.deps.session.getToken() || record?.downloadable !== true || record?.has_downloads_left !== true) return null
    const fallBack = async (reason: string) => {
      await this.host.logger.info('SoundCloud original unavailable; using the stream', { sourceId: job.sourceId, reason }).catch(() => {})
      return null
    }
    let temporary: string | null = null
    try {
      const answer = asRecord(await this.deps.client.request({ path: `tracks/${job.sourceId}/download`, auth: 'required', plainErrors: true, signal }))
      const redirect = asString(answer?.redirectUri)
      if (!redirect || !redirect.startsWith('https://')) return await fallBack('no-download-address')
      const downloaded = path.join(work, 'original')
      const { head } = await downloadFile(redirect, downloaded, { fetch: this.deps.fetch, signal, onProgress: report })
      const container = sniffContainer(head)
      if (!container) return await fallBack('unsupported-container')
      temporary = path.join(audioDirectory, `.tmp-${job.sourceId}.${randomUUID()}.${container}`)
      await fs.rename(downloaded, temporary)
      const expectedMs = asNumber(record.full_duration) ?? asNumber(record.duration)
      const inspected = await this.verify(temporary, expectedMs, ORIGINAL_DURATION_TOLERANCE_MS, signal)
      if (!ORIGINAL_FORMATS.has(inspected.format)) return await fallBack(`format-${inspected.format}`)
      const final = path.join(audioDirectory, `${job.sourceId}.original.r${PREPARATION_REVISION}.${EXTENSIONS[inspected.format]}`)
      await fs.rename(temporary, final)
      temporary = null
      return { artifact: { path: final, lifecycle: 'complete' as const, format: plainFormat(inspected) }, quality: `original-${inspected.format}` }
    } catch (error) {
      const code = errorCode(error)
      if (code === 'CANCELLED' || code === 'AUTH_EXPIRED' || signal.aborted) throw error
      return await fallBack(code)
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  /** Decode the whole file, compare its length with SoundCloud's, and read its stream info. */
  private async verify(file: string, expectedMs: number | null, toleranceMs: number, signal: AbortSignal): Promise<FormatInfoV1> {
    if (signal.aborted) throw cancelled()
    const durationMs = await this.probe(this.host.helpers, file, signal)
    if (durationMs === null || durationMs <= 0
      || (expectedMs !== null && expectedMs > 0 && Math.abs(durationMs - expectedMs) > Math.max(toleranceMs, expectedMs * 0.02))) {
      throw apiError('NETWORK', 'The downloaded SoundCloud audio has an unexpected length', true)
    }
    const inspected = await this.host.cache.inspectFormat(file).catch(() => null)
    if (!inspected || inspected.sampleRate <= 0 || inspected.channels <= 0) throw apiError('INTERNAL', 'The downloaded SoundCloud audio has no readable stream info')
    if (signal.aborted) throw cancelled()
    return inspected
  }
}
