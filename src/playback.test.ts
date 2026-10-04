import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FormatInfoV1, ProviderEventV1, ProviderHelperOutputV1 } from 'puros-provider-sdk'
import { SoundCloudCatalog } from './catalog'
import { track } from './fixtures'
import { SoundCloudPlayback, type AudioSource } from './playback'
import { fakeSoundCloud, json, testClient } from './testing'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const AAC = 'audio/mp4; codecs="mp4a.40.2"'
const CDN = 'https://cf-media.sndcdn.com'
const transcoding = (preset: string, protocol: string, mime: string, extra: Record<string, unknown> = {}) => ({
  url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:1/${preset}/stream/${protocol === 'progressive' ? 'progressive' : 'hls'}`,
  preset, duration: 103_430, snipped: false, quality: 'sq', format: { protocol, mime_type: mime }, ...extra,
})
const WAV_HEAD = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(64)])

interface Setup {
  transcodings: unknown[]
  trackExtra?: Record<string, unknown>
  source?: AudioSource
  token?: string | null
  media?: Record<string, () => Response | Promise<Response>>
  probeMs?: number
}

function setup(options: Setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-sc-playback-'))
  roots.push(root)
  const cacheRoot = path.join(root, 'cache')
  fs.mkdirSync(cacheRoot)
  const events: ProviderEventV1[] = []
  const cache = new Map<string, { path: string; format: FormatInfoV1; resolvedSourceId: string; resolvedQuality?: string }>()
  const spawned: string[] = []
  const handles = new Map<string, ProviderHelperOutputV1[]>()
  let handleCount = 0
  const counters = { trackRequests: 0, mediaRequests: 0, downloads: 0 }

  const api = fakeSoundCloud({
    'tracks/1': () => { counters.trackRequests += 1; return json(track(1, 'One', { media: { transcodings: options.transcodings }, ...options.trackExtra })) },
    'tracks/1/download': () => json({ redirectUri: `${CDN}/original/1.wav` }),
    ...Object.fromEntries((options.transcodings as Array<{ url: string; preset: string; format: { protocol: string } }>).map((t) => [
      t.url.replace('https://api-v2.soundcloud.com/', ''),
      () => { counters.mediaRequests += 1; return json({ url: `${CDN}/${t.preset}/${t.format.protocol}` }) },
    ])),
  })
  const media: Record<string, () => Response | Promise<Response>> = {
    [`${CDN}/mp3_1_0/progressive`]: () => new Response(Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]), { headers: { 'content-length': '8' } }),
    [`${CDN}/aac_160k/hls`]: () => new Response(`#EXTM3U\n#EXT-X-MAP:URI="${CDN}/seg/init.mp4"\n#EXTINF:60,\n${CDN}/seg/0.m4s\n#EXTINF:43.43,\n${CDN}/seg/1.m4s\n#EXT-X-ENDLIST\n`),
    [`${CDN}/seg/init.mp4`]: () => new Response('INIT'),
    [`${CDN}/seg/0.m4s`]: () => new Response('SEG0'),
    [`${CDN}/seg/1.m4s`]: () => new Response('SEG1'),
    [`${CDN}/original/1.wav`]: () => new Response(WAV_HEAD),
    ...options.media,
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(CDN)) {
      counters.downloads += 1
      const route = media[url]
      return route ? route() : new Response('missing', { status: 404 })
    }
    return api.fetch(input, init)
  }) as typeof fetch

  const token = options.token === undefined ? null : options.token
  const client = testClient(fetchImpl, { token: () => token })
  const catalog = new SoundCloudCatalog(client, () => null)
  const formatOf = (file: string): FormatInfoV1 | null => {
    const extension = path.extname(file)
    const format = extension === '.mp3' ? 'MP3' : extension === '.m4a' ? 'AAC' : extension === '.wav' ? 'WAV' : null
    if (!format) return null
    return { format, sampleRate: 44_100, bitDepth: format === 'WAV' ? 24 : 0, bitrate: format === 'WAV' ? 2117 : 128, channels: 2, isLossless: format === 'WAV', isHiRes: format === 'WAV', isMqa: false, isDsd: false }
  }

  const playback = new SoundCloudPlayback({
    host: {
      paths: { getCacheRoot: async () => cacheRoot, getDataRoot: async () => root, getResourceRoot: async () => root },
      cache: {
        get: async ({ sourceId, qualityKey }) => cache.get(`${qualityKey}:${sourceId}`) ?? null,
        put: async (entry) => { cache.set(`${entry.qualityKey}:${entry.sourceId}`, { path: entry.path, format: entry.format, resolvedSourceId: entry.resolvedSourceId!, resolvedQuality: entry.resolvedQuality }) },
        inspectFormat: async (file) => formatOf(file),
        canPlayFormat: async () => true,
        trim: async () => {},
      },
      helpers: {
        async spawn({ binaryId, args }) {
          spawned.push(binaryId)
          const handleId = `h${handleCount += 1}`
          if (binaryId === 'remux-m4a') fs.copyFileSync(args![7], args![args!.length - 1])
          const durationMs = options.probeMs ?? 103_430
          const time = new Date(durationMs).toISOString().slice(11, 22)
          handles.set(handleId, [
            ...(binaryId === 'probe' ? [{ type: 'stderr' as const, data: new TextEncoder().encode(`size=N/A time=${time} bitrate=N/A`) }] : []),
            { type: 'exit', exitCode: 0, signal: null },
          ])
          return { handleId }
        },
        async write() {},
        async closeStdin() {},
        async read(handleId) { return handles.get(handleId)!.shift()! },
        async terminate() {},
      },
      logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      catalog: { getStoredTrack: async () => null, getPlaybackRecoverySeed: async () => null, listTracksNeedingFormat: async () => [], updateTrackFormat: async () => {} },
      events: { emit: async (event) => { events.push(event) } },
    },
    session: { accountKey: () => (token ? 'uaccount' : 'guest'), getToken: () => token },
    client,
    catalog,
    audioSource: async () => options.source ?? 'stream',
    fetch: fetchImpl,
    sleep: async () => {},
  })
  return { playback, cacheRoot, cache, spawned, events, counters }
}

const MP3 = transcoding('mp3_1_0', 'progressive', 'audio/mpeg')
const AAC_160 = transcoding('aac_160k', 'hls', AAC)

describe('SoundCloudPlayback', () => {
  it('prefers AAC 160 over HLS, concatenates init and segments in order, and remuxes it to M4A', async () => {
    const { playback, cacheRoot, spawned, cache } = setup({ transcodings: [MP3, AAC_160] })
    const artifact = await playback.resolve({ sourceId: '1', intent: 'playback' })
    expect(artifact.lifecycle).toBe('complete')
    expect(path.relative(cacheRoot, artifact.path)).toBe(path.join('audio', 'guest', '1.aac_160k.r1.m4a'))
    expect(fs.readFileSync(artifact.path, 'utf8')).toBe('INITSEG0SEG1')
    expect(artifact.format).toEqual({ format: 'AAC', sampleRate: 44_100, bitDepth: 0, bitrate: 160, channels: 2, isLossless: false, isHiRes: false, isMqa: false, isDsd: false })
    expect(spawned).toEqual(['remux-m4a', 'probe'])
    expect([...cache.values()][0].resolvedQuality).toBe('stream-aac_160k')
    // Intermediates are gone.
    expect(fs.readdirSync(path.join(cacheRoot, 'work'))).toEqual([])
  })

  it('keeps a progressive MP3 as it is, without ffmpeg remuxing', async () => {
    const { playback, spawned } = setup({ transcodings: [MP3] })
    const artifact = await playback.resolve({ sourceId: '1', intent: 'playback' })
    expect(artifact.path.endsWith('1.mp3_1_0.r1.mp3')).toBe(true)
    expect(artifact.format).toMatchObject({ format: 'MP3', bitrate: 128, bitDepth: 0, isLossless: false })
    expect(spawned).toEqual(['probe'])
  })

  it('downloads once for concurrent callers and serves the cache afterwards', async () => {
    const { playback, counters } = setup({ transcodings: [MP3] })
    const [a, b] = await Promise.all([
      playback.resolve({ sourceId: '1', intent: 'playback' }),
      playback.prefetch({ sourceId: '1' }),
    ])
    expect(b?.path).toBe(a.path)
    await playback.resolve({ sourceId: '1', intent: 'playback' })
    expect(counters.trackRequests).toBe(1)
    expect(counters.downloads).toBe(1)
  })

  it('refuses previews and DRM-only tracks with typed errors', async () => {
    const preview = setup({ transcodings: [transcoding('mp3_1_0', 'hls', 'audio/mpeg', { snipped: true })], trackExtra: { policy: 'SNIP' } })
    await expect(preview.playback.resolve({ sourceId: '1', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'PERMISSION_DENIED' } })
    const drm = setup({ transcodings: [transcoding('aac_160k', 'cbc-encrypted-hls', AAC)] })
    await expect(drm.playback.resolve({ sourceId: '1', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NOT_SUPPORTED' } })
    expect(await drm.playback.prefetch({ sourceId: '1' })).toBeNull()
  })

  it('renews an expired media address and retries', async () => {
    let first = true
    const { playback, counters } = setup({
      transcodings: [MP3],
      media: { [`${CDN}/mp3_1_0/progressive`]: () => {
        if (first) { first = false; return new Response('expired', { status: 403 }) }
        return new Response(Buffer.from([0xff, 0xfb, 0x90, 0x64]))
      } },
    })
    await expect(playback.resolve({ sourceId: '1', intent: 'playback' })).resolves.toMatchObject({ lifecycle: 'complete' })
    expect(counters.mediaRequests).toBe(2)
  })

  it('rejects a file whose decoded length is wrong', async () => {
    const { playback } = setup({ transcodings: [MP3], probeMs: 30_000 })
    await expect(playback.resolve({ sourceId: '1', intent: 'playback' })).rejects.toThrow(/unexpected length/)
  })

  it('uses the original upload when chosen, signed in and downloadable', async () => {
    const { playback, spawned, cache } = setup({ transcodings: [MP3], source: 'original', token: 'tok', trackExtra: { downloadable: true, has_downloads_left: true } })
    const artifact = await playback.resolve({ sourceId: '1', intent: 'playback' })
    expect(artifact.path.endsWith(path.join('uaccount', '1.original.r1.wav'))).toBe(true)
    expect(artifact.format).toMatchObject({ format: 'WAV', bitDepth: 24, isLossless: true })
    expect(spawned).toEqual(['probe'])
    expect([...cache.keys()]).toEqual(['original-r1-uaccount:1'])
  })

  it('falls back to the stream for originals core cannot play or that are not offered', async () => {
    const ogg = setup({
      transcodings: [MP3], source: 'original', token: 'tok', trackExtra: { downloadable: true, has_downloads_left: true },
      media: { [`${CDN}/original/1.wav`]: () => new Response(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)])) },
    })
    await expect(ogg.playback.resolve({ sourceId: '1', intent: 'playback' })).resolves.toMatchObject({ format: { format: 'MP3' } })
    const noDownloads = setup({ transcodings: [MP3], source: 'original', token: 'tok', trackExtra: { downloadable: true, has_downloads_left: false } })
    await expect(noDownloads.playback.resolve({ sourceId: '1', intent: 'playback' })).resolves.toMatchObject({ format: { format: 'MP3' } })
    const signedOut = setup({ transcodings: [MP3], source: 'original', trackExtra: { downloadable: true, has_downloads_left: true } })
    await expect(signedOut.playback.resolve({ sourceId: '1', intent: 'playback' })).resolves.toMatchObject({ format: { format: 'MP3' } })
  })

  it('cancels a playback download when its session is cancelled', async () => {
    let release!: () => void
    const { playback, cacheRoot } = setup({
      transcodings: [MP3],
      media: { [`${CDN}/mp3_1_0/progressive`]: () => new Promise<Response>((resolve) => { release = () => resolve(new Response(Buffer.from([0xff, 0xfb]))) }) },
    })
    const pending = playback.resolve({ sourceId: '1', intent: 'playback', sessionId: 'session-0001' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await playback.cancelSession('session-0001')).toBe(true)
    release()
    await expect(pending).rejects.toMatchObject({ providerError: { code: 'CANCELLED' } })
    expect(fs.readdirSync(path.join(cacheRoot, 'audio', 'guest'))).toEqual([])
  })

  it('reports progress for a caller session', async () => {
    const { playback, events } = setup({ transcodings: [AAC_160] })
    await playback.resolve({ sourceId: '1', intent: 'playback', sessionId: 'session-0002' })
    const progress = events.filter((event) => event.type === 'playback.progress')
    expect(progress[progress.length - 1]).toMatchObject({ progress: { sessionId: 'session-0002', state: 'completed', percent: 100 } })
  })

  it('validates the track ID before any request', async () => {
    const { playback, counters } = setup({ transcodings: [MP3] })
    await expect(playback.resolve({ sourceId: '../1', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    expect(counters.trackRequests).toBe(0)
  })
})
