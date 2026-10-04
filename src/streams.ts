import { apiError } from './api'
import { asArray, asNumber, asRecord, asString } from './json'

/**
 * One transcoding of `track.media.transcodings`, as api-v2 lists them:
 * `aac_160k` and `aac_96k` HLS (fragmented MP4), `mp3_*` progressive and HLS
 * (128 kb/s), `quality: "hq"` AAC for SoundCloud Go+ (256 kb/s), plus DRM
 * variants (`ctr-`/`cbc-encrypted-hls`) and the broken `abr_*` master playlist.
 */
export interface Transcoding {
  url: string
  preset: string
  protocol: 'progressive' | 'hls'
  codec: 'AAC' | 'MP3'
  bitrateKbps: number
  premium: boolean
  durationMs: number | null
}

export type StreamUnavailableReason = 'preview-only' | 'drm-only' | 'blocked' | 'none'

function codecOf(mimeType: string, preset: string): 'AAC' | 'MP3' | null {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('audio/mpeg') && preset.startsWith('mp3')) return 'MP3'
  if (mime.startsWith('audio/mp4') && /codecs="mp4a\./.test(mime)) return 'AAC'
  return null
}

/** Declared bitrate: the `_160k` preset suffix, 256 for Go+ AAC, 128 for every MP3 SoundCloud serves. */
function bitrateOf(preset: string, codec: 'AAC' | 'MP3', premium: boolean): number {
  const suffix = preset.match(/_(\d{2,3})k$/)
  if (suffix) return Number(suffix[1])
  if (codec === 'AAC' && premium) return 256
  return codec === 'MP3' ? 128 : 0
}

/** Transcodings core can play as they are, without DRM, previews or the broken adaptive preset. */
export function playableTranscodings(track: unknown): { transcodings: Transcoding[]; reason: StreamUnavailableReason } {
  const record = asRecord(track)
  const all = asArray(asRecord(record?.media)?.transcodings).map(asRecord).filter((value) => value !== null)
  const transcodings: Transcoding[] = []
  let sawPreview = false
  let sawDrm = false
  for (const entry of all) {
    const url = asString(entry.url)
    const preset = asString(entry.preset)?.toLowerCase()
    const format = asRecord(entry.format)
    const protocol = asString(format?.protocol)?.toLowerCase() ?? ''
    if (!url || !preset) continue
    if (/^(?:ctr-|cbc-)|encrypted/.test(protocol) || url.includes('/encrypted-hls')) { sawDrm = true; continue }
    if (entry.snipped === true || url.includes('/preview/')) { sawPreview = true; continue }
    if (preset.startsWith('abr')) continue
    const kind = protocol === 'progressive' ? 'progressive' : protocol === 'hls' ? 'hls' : null
    const codec = codecOf(asString(format?.mime_type) ?? '', preset)
    if (!kind || !codec) continue
    const premium = asString(entry.quality)?.toLowerCase() === 'hq'
    transcodings.push({
      url, preset, protocol: kind, codec, premium,
      bitrateKbps: bitrateOf(preset, codec, premium),
      durationMs: asNumber(entry.duration),
    })
  }
  const blocked = asString(record?.policy)?.toUpperCase() === 'BLOCK'
  const reason: StreamUnavailableReason = transcodings.length > 0 ? 'none'
    : blocked ? 'blocked' : sawPreview ? 'preview-only' : sawDrm ? 'drm-only' : 'none'
  return { transcodings: rankTranscodings(transcodings), reason }
}

/**
 * Best first: AAC at 160 kb/s and up (Go+ 256 kb/s first), then 128 kb/s MP3
 * (progressive before HLS, the same encoding as one file), then low-quality
 * AAC 96 kb/s. AAC at 160 kb/s is SoundCloud's own higher tier over its MP3.
 */
export function rankTranscodings(transcodings: Transcoding[]): Transcoding[] {
  const score = (t: Transcoding) => {
    if (t.codec === 'AAC' && t.bitrateKbps >= 160) return 3_000 + t.bitrateKbps
    if (t.codec === 'MP3') return 2_000 + t.bitrateKbps + (t.protocol === 'progressive' ? 1 : 0)
    return 1_000 + t.bitrateKbps
  }
  return [...transcodings].sort((a, b) => score(b) - score(a))
}

export function unavailableError(reason: StreamUnavailableReason) {
  switch (reason) {
    case 'preview-only':
      return apiError('PERMISSION_DENIED', 'SoundCloud offers only a 30-second preview of this track to this account (it needs SoundCloud Go+)')
    case 'drm-only':
      return apiError('NOT_SUPPORTED', 'SoundCloud streams this track only with DRM, which Puros cannot play')
    case 'blocked':
      return apiError('NOT_FOUND', 'This track is not available on SoundCloud in your country')
    default:
      return apiError('NOT_SUPPORTED', 'SoundCloud offered no playable stream for this track')
  }
}

export interface HlsPlaylist {
  /** fMP4 initialization segment (`#EXT-X-MAP`), absent for raw MP3 segments. */
  initUrl: string | null
  segments: Array<{ url: string; durationSeconds: number }>
}

function mediaUrl(value: string, base: string): string {
  const url = new URL(value, base)
  if (url.protocol !== 'https:') throw apiError('INTERNAL', 'SoundCloud returned a non-HTTPS media address')
  return url.toString()
}

/**
 * A SoundCloud VOD media playlist. Anything this provider cannot download as
 * plain bytes fails closed: encryption keys, byte ranges, discontinuities,
 * master playlists, or a playlist without `#EXT-X-ENDLIST`.
 */
export function parseHlsPlaylist(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') throw apiError('INTERNAL', 'SoundCloud returned an unreadable HLS playlist', true)
  let initUrl: string | null = null
  let pendingDuration: number | null = null
  let ended = false
  const segments: HlsPlaylist['segments'] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-KEY')) {
      if (!/METHOD=NONE/.test(line)) throw apiError('NOT_SUPPORTED', 'SoundCloud encrypted this stream')
    } else if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-BYTERANGE') || line.startsWith('#EXT-X-DISCONTINUITY')) {
      throw apiError('NOT_SUPPORTED', 'SoundCloud returned an HLS layout Puros does not download')
    } else if (line.startsWith('#EXT-X-MAP')) {
      const uri = line.match(/URI="([^"]+)"/)?.[1]
      if (!uri || /BYTERANGE=/.test(line) || initUrl) throw apiError('NOT_SUPPORTED', 'SoundCloud returned an HLS layout Puros does not download')
      initUrl = mediaUrl(uri, baseUrl)
    } else if (line.startsWith('#EXTINF:')) {
      const duration = Number.parseFloat(line.slice('#EXTINF:'.length))
      pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true
    } else if (!line.startsWith('#')) {
      if (pendingDuration === null) throw apiError('INTERNAL', 'SoundCloud returned an unreadable HLS playlist', true)
      segments.push({ url: mediaUrl(line, baseUrl), durationSeconds: pendingDuration })
      pendingDuration = null
    }
  }
  if (!ended || segments.length === 0) throw apiError('INTERNAL', 'SoundCloud returned an incomplete HLS playlist', true)
  return { initUrl, segments }
}

/** The container of an original upload, from its first bytes; null for anything core should not be handed. */
export function sniffContainer(head: Uint8Array): 'flac' | 'wav' | 'aiff' | 'mp3' | 'm4a' | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end))
  if (head.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac'
  if (head.length >= 12 && (ascii(0, 4) === 'RIFF' || ascii(0, 4) === 'RF64') && ascii(8, 12) === 'WAVE') return 'wav'
  if (head.length >= 12 && ascii(0, 4) === 'FORM' && (ascii(8, 12) === 'AIFF' || ascii(8, 12) === 'AIFC')) return 'aiff'
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') return 'm4a'
  if (head.length >= 10 && ascii(0, 3) === 'ID3') {
    // An ID3v2 tag can precede FLAC as well as MP3: look at what follows it (syncsafe size, optional footer).
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
    const next = 10 + size + (head[5] & 0x10 ? 10 : 0)
    if (next + 4 > head.length) return 'mp3'
    const inner = sniffContainer(head.subarray(next))
    return inner === 'flac' ? 'flac' : 'mp3'
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}
