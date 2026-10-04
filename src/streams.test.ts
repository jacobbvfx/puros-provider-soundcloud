import { describe, expect, it } from 'vitest'
import { parseHlsPlaylist, playableTranscodings, sniffContainer } from './streams'

const media = (path: string) => `https://api-v2.soundcloud.com/media/soundcloud:tracks:1/${path}`
const transcoding = (preset: string, protocol: string, mime: string, quality = 'sq', extra: Record<string, unknown> = {}) => ({
  url: media(`${preset}-${protocol}/stream/${protocol === 'progressive' ? 'progressive' : 'hls'}`),
  preset, duration: 103_430, snipped: false, quality, format: { protocol, mime_type: mime }, ...extra,
})
const AAC = 'audio/mp4; codecs="mp4a.40.2"'

describe('playableTranscodings', () => {
  it('ranks AAC 160 over MP3 128 over AAC 96 and drops the adaptive preset (2026-10 layout)', () => {
    const { transcodings, reason } = playableTranscodings({
      policy: 'ALLOW',
      media: { transcodings: [
        transcoding('aac_96k', 'hls', AAC, 'lq'),
        transcoding('abr_sq', 'hls', 'audio/mpegurl'),
        transcoding('mp3_1_0', 'hls', 'audio/mpeg'),
        transcoding('mp3_1_0', 'progressive', 'audio/mpeg'),
        transcoding('aac_160k', 'hls', AAC),
      ] },
    })
    expect(reason).toBe('none')
    expect(transcodings.map((t) => `${t.preset}/${t.protocol}/${t.bitrateKbps}`)).toEqual([
      'aac_160k/hls/160', 'mp3_1_0/progressive/128', 'mp3_1_0/hls/128', 'aac_96k/hls/96',
    ])
  })

  it('puts Go+ AAC (quality hq) first at 256 kb/s', () => {
    const { transcodings } = playableTranscodings({ media: { transcodings: [
      transcoding('aac_160k', 'hls', AAC),
      transcoding('aac_hq', 'hls', AAC, 'hq'),
    ] } })
    expect(transcodings[0]).toMatchObject({ preset: 'aac_hq', premium: true, bitrateKbps: 256, codec: 'AAC' })
  })

  it('never offers a 30-second preview as the track', () => {
    const result = playableTranscodings({ policy: 'SNIP', media: { transcodings: [
      transcoding('mp3_1_0', 'hls', 'audio/mpeg', 'sq', { snipped: true }),
      transcoding('mp3_1_0', 'progressive', 'audio/mpeg', 'sq', { snipped: true }),
    ] } })
    expect(result).toEqual({ transcodings: [], reason: 'preview-only' })
  })

  it('skips DRM variants and reports DRM when nothing else exists', () => {
    const drmOnly = playableTranscodings({ media: { transcodings: [
      transcoding('aac_160k', 'ctr-encrypted-hls', AAC),
      transcoding('aac_160k', 'cbc-encrypted-hls', AAC),
    ] } })
    expect(drmOnly.reason).toBe('drm-only')
    const mixed = playableTranscodings({ media: { transcodings: [
      transcoding('aac_160k', 'cbc-encrypted-hls', AAC),
      transcoding('mp3_1_0', 'hls', 'audio/mpeg'),
    ] } })
    expect(mixed.transcodings.map((t) => t.preset)).toEqual(['mp3_1_0'])
  })

  it('reports geo blocking', () => {
    expect(playableTranscodings({ policy: 'BLOCK', media: { transcodings: [] } }).reason).toBe('blocked')
  })
})

describe('parseHlsPlaylist', () => {
  const base = 'https://playback.media-streaming.soundcloud.cloud/x/aac_160k/abc/playlist.m3u8?sig=1'

  it('reads an fMP4 AAC playlist with its init segment', () => {
    const playlist = parseHlsPlaylist([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="https://playback.media-streaming.soundcloud.cloud/x/init.mp4?s=1"',
      '#EXTINF:10.0078,', 'https://playback.media-streaming.soundcloud.cloud/x/data000.m4s?s=1',
      '#EXTINF:3.5,', 'data001.m4s?s=1',
      '#EXT-X-ENDLIST', '',
    ].join('\n'), base)
    expect(playlist.initUrl).toBe('https://playback.media-streaming.soundcloud.cloud/x/init.mp4?s=1')
    expect(playlist.segments.map((s) => s.url)).toEqual([
      'https://playback.media-streaming.soundcloud.cloud/x/data000.m4s?s=1',
      'https://playback.media-streaming.soundcloud.cloud/x/aac_160k/abc/data001.m4s?s=1',
    ])
    expect(playlist.segments.reduce((sum, s) => sum + s.durationSeconds, 0)).toBeCloseTo(13.5078)
  })

  it('reads a raw MP3 playlist', () => {
    const playlist = parseHlsPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1.985,\nhttps://cf-hls-media.sndcdn.com/media/0/31762/a.128.mp3?p=1\n#EXT-X-ENDLIST\n', base)
    expect(playlist.initUrl).toBeNull()
    expect(playlist.segments).toHaveLength(1)
  })

  it('fails closed on encryption, byte ranges, master playlists and live playlists', () => {
    const body = (line: string) => `#EXTM3U\n${line}\n#EXTINF:1,\nhttps://a.example/x\n#EXT-X-ENDLIST\n`
    expect(() => parseHlsPlaylist(body('#EXT-X-KEY:METHOD=AES-128,URI="https://k"'), base)).toThrow(/encrypted/)
    expect(() => parseHlsPlaylist(body('#EXT-X-BYTERANGE:100@0'), base)).toThrow()
    expect(() => parseHlsPlaylist(body('#EXT-X-STREAM-INF:BANDWIDTH=1'), base)).toThrow()
    expect(() => parseHlsPlaylist('#EXTM3U\n#EXTINF:1,\nhttps://a.example/x\n', base)).toThrow(/incomplete/)
    expect(() => parseHlsPlaylist('#EXTM3U\n#EXTINF:1,\nhttp://a.example/x\n#EXT-X-ENDLIST\n', base)).toThrow(/non-HTTPS/)
  })
})

describe('sniffContainer', () => {
  const bytes = (text: string, pad = 16) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(pad)])
  it('recognizes the containers core plays and nothing else', () => {
    expect(sniffContainer(bytes('fLaC'))).toBe('flac')
    expect(sniffContainer(bytes('RIFF\0\0\0\0WAVE'))).toBe('wav')
    expect(sniffContainer(bytes('FORM\0\0\0\0AIFF'))).toBe('aiff')
    expect(sniffContainer(bytes('\0\0\0\x20ftypM4A '))).toBe('m4a')
    expect(sniffContainer(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3')
    expect(sniffContainer(bytes('OggS'))).toBeNull()
    expect(sniffContainer(bytes('PK\x03\x04'))).toBeNull()
  })

  it('looks past an ID3v2 tag', () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0])
    expect(sniffContainer(Buffer.concat([id3, bytes('fLaC')]))).toBe('flac')
    expect(sniffContainer(Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x64])]))).toBe('mp3')
  })
})
