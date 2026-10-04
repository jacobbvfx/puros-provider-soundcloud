import fs from 'node:fs/promises'
import { apiError } from './api'
import { USER_AGENT } from './constants'
import { parseHlsPlaylist } from './streams'

export interface MediaProgress {
  bytes: number
  totalBytes: number | null
  /** HLS: finished segments and how many there are. */
  items?: number
  itemsTotal?: number
}

export interface MediaOptions {
  fetch?: typeof fetch
  signal: AbortSignal
  onProgress?(progress: MediaProgress): void
  /** Abort a transfer that delivers nothing for this long. */
  idleTimeoutMs?: number
  /** Parallel HLS segment requests. */
  concurrency?: number
}

const SNIFF_BYTES = 64 * 1024
const SEGMENT_ATTEMPTS = 3

function cancelled() {
  return apiError('CANCELLED', 'SoundCloud download cancelled', true)
}

/** CDN answers mapped to typed errors; a signed URL that expired (403/410) is retryable with a fresh one. */
function statusError(status: number) {
  if (status === 403 || status === 410) return apiError('NETWORK', 'The SoundCloud stream address expired; it will be renewed', true)
  if (status === 404) return apiError('NOT_FOUND', 'SoundCloud no longer has this audio file')
  if (status === 429) return apiError('RATE_LIMITED', 'SoundCloud is rate limiting downloads; try again shortly', true, 10_000)
  if (status >= 500) return apiError('NETWORK', `SoundCloud media server error (HTTP ${status})`, true)
  return apiError('INTERNAL', `SoundCloud media request failed (HTTP ${status})`)
}

/** `fetch` with an idle watchdog: every chunk re-arms it; silence aborts as TIMEOUT. */
async function open(url: string, options: MediaOptions): Promise<{ response: Response; touch(): void; done(): void; timedOut(): boolean }> {
  if (options.signal.aborted) throw cancelled()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const idleMs = options.idleTimeoutMs ?? 30_000
  let idle = false
  let timer = setTimeout(() => { idle = true; controller.abort() }, idleMs)
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; controller.abort() }, idleMs) }
  const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', onAbort) }
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    done()
    if (options.signal.aborted) throw cancelled()
    if (idle) throw apiError('TIMEOUT', 'SoundCloud stopped sending audio', true)
    throw apiError('NETWORK', `SoundCloud media is unreachable (${error instanceof Error ? error.name : 'network error'})`, true)
  }
  if (response.url && !response.url.startsWith('https:')) {
    done()
    await response.body?.cancel().catch(() => {})
    throw apiError('INTERNAL', 'SoundCloud redirected the download to a non-HTTPS address')
  }
  if (!response.ok) {
    done()
    await response.body?.cancel().catch(() => {})
    throw statusError(response.status)
  }
  return { response, touch, done, timedOut: () => idle }
}

async function readBody(url: string, options: MediaOptions, onChunk: (chunk: Uint8Array, expected: number | null) => Promise<void>): Promise<{ bytes: number; expected: number | null }> {
  const { response, touch, done, timedOut } = await open(url, options)
  const declared = Number(response.headers.get('content-length'))
  const expected = Number.isSafeInteger(declared) && declared > 0 && !response.headers.get('content-encoding') ? declared : null
  let bytes = 0
  try {
    if (!response.body) throw apiError('NETWORK', 'SoundCloud sent no audio', true)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      touch()
      bytes += chunk.length
      await onChunk(chunk, expected)
    }
  } catch (error) {
    if (options.signal.aborted) throw cancelled()
    if (timedOut()) throw apiError('TIMEOUT', 'SoundCloud stopped sending audio', true)
    if (error instanceof Error && error.name === 'ProviderApiError') throw error
    throw apiError('NETWORK', 'The SoundCloud download was interrupted', true)
  } finally {
    done()
  }
  if (expected !== null && bytes !== expected) throw apiError('NETWORK', 'The SoundCloud download is incomplete', true)
  if (bytes === 0) throw apiError('NETWORK', 'SoundCloud sent an empty file', true)
  return { bytes, expected }
}

/** Download one file to a new path (0600). Returns its size and its first bytes for container sniffing. */
export async function downloadFile(url: string, file: string, options: MediaOptions): Promise<{ bytes: number; head: Uint8Array }> {
  const handle = await fs.open(file, 'wx', 0o600)
  const head: Uint8Array[] = []
  let headBytes = 0
  let written = 0
  try {
    const { bytes, expected } = await readBody(url, options, async (chunk, total) => {
      if (headBytes < SNIFF_BYTES) {
        head.push(chunk.subarray(0, SNIFF_BYTES - headBytes))
        headBytes += Math.min(chunk.length, SNIFF_BYTES - headBytes)
      }
      await handle.write(chunk)
      written += chunk.length
      options.onProgress?.({ bytes: written, totalBytes: total })
    })
    await handle.sync()
    options.onProgress?.({ bytes, totalBytes: expected })
    return { bytes, head: Buffer.concat(head) }
  } finally {
    await handle.close()
  }
}

async function fetchBytes(url: string, options: MediaOptions): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    const chunks: Uint8Array[] = []
    try {
      await readBody(url, options, async (chunk) => { chunks.push(chunk) })
      return Buffer.concat(chunks)
    } catch (error) {
      const typed = error instanceof Error && 'providerError' in error ? (error as { providerError: { code: string; retryable: boolean } }).providerError : null
      // An expired segment URL needs a new playlist; only transient transfer failures are retried here.
      if (!typed?.retryable || typed.code === 'CANCELLED' || /expired/.test((error as Error).message) || attempt >= SEGMENT_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
}

/**
 * Download an HLS VOD stream into one file: the fMP4 init segment (if any)
 * followed by every media segment, in order. Segments are fetched a few at a
 * time but written strictly in sequence, so the file is the exact byte
 * concatenation the player would have buffered.
 */
export async function downloadHls(playlistUrl: string, file: string, options: MediaOptions): Promise<{ bytes: number; durationSeconds: number; fragmentedMp4: boolean }> {
  const chunks: Uint8Array[] = []
  await readBody(playlistUrl, options, async (chunk) => { chunks.push(chunk) })
  const playlist = parseHlsPlaylist(Buffer.concat(chunks).toString('utf8'), playlistUrl)
  const urls = [...(playlist.initUrl ? [playlist.initUrl] : []), ...playlist.segments.map((segment) => segment.url)]
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const inner: MediaOptions = { ...options, signal: controller.signal }
  const pending: Array<Promise<Uint8Array>> = []
  let started = 0
  const start = () => {
    const promise = fetchBytes(urls[started], inner)
    promise.catch(() => {})
    pending.push(promise)
    started += 1
  }
  const handle = await fs.open(file, 'wx', 0o600)
  let bytes = 0
  try {
    for (let index = 0; index < Math.min(options.concurrency ?? 8, urls.length); index += 1) start()
    for (let index = 0; index < urls.length; index += 1) {
      const data = await pending[index]
      await handle.write(data)
      bytes += data.length
      if (started < urls.length) start()
      options.onProgress?.({ bytes, totalBytes: null, items: index + 1, itemsTotal: urls.length })
    }
    await handle.sync()
  } catch (error) {
    controller.abort()
    if (options.signal.aborted) throw cancelled()
    throw error
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    await handle.close()
  }
  return {
    bytes,
    durationSeconds: playlist.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
    fragmentedMp4: playlist.initUrl !== null,
  }
}
