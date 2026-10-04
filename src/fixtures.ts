/**
 * Trimmed api-v2 objects in the shapes live signed-out responses had on
 * 2026-10-02 (public catalog data only; no account data, no
 * `track_authorization` values). Builders keep each test's intent visible.
 */

export const user = (id: number, username: string, extra: Record<string, unknown> = {}) => ({
  avatar_url: `https://i1.sndcdn.com/avatars-${id}-abc-large.jpg`,
  description: null,
  id,
  kind: 'user',
  permalink: username.toLowerCase().replace(/\W+/g, ''),
  permalink_url: `https://soundcloud.com/${username.toLowerCase().replace(/\W+/g, '')}`,
  track_count: 10,
  urn: `soundcloud:users:${id}`,
  username,
  ...extra,
})

export const BICEP = user(92661, 'BICEP', { description: 'BOOKING\n\nAmericas: …', track_count: 423 })

export const track = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  artwork_url: `https://i1.sndcdn.com/artworks-${id}-128osm-large.jpg`,
  downloadable: false,
  duration: 103_430,
  full_duration: 103_453,
  genre: 'Electronic',
  has_downloads_left: false,
  id,
  kind: 'track',
  label_name: 'Ninja Tune',
  permalink_url: `https://soundcloud.com/feelmybicep/track-${id}`,
  policy: 'ALLOW',
  publisher_metadata: null,
  release_date: null,
  title,
  track_authorization: 'test-authorization',
  user: BICEP,
  media: { transcodings: [] },
  ...extra,
})

export const GLUE_PUBLISHER = {
  id: 336067387,
  urn: 'soundcloud:tracks:336067387',
  artist: 'Bicep',
  album_title: 'Bicep',
  contains_music: true,
  publisher: 'Copyright Control',
  upc_or_ean: '5054429119862',
  isrc: 'GBCFB1700229',
  writer_composer: 'Bicep',
}

export const GLUE = track(336067387, 'BICEP | GLUE // CLIP', { publisher_metadata: GLUE_PUBLISHER })

export const stub = (id: number) => ({ id, kind: 'track', monetization_model: 'NOT_APPLICABLE', policy: 'ALLOW' })

export const set = (id: number, title: string, tracks: unknown[], extra: Record<string, unknown> = {}) => ({
  artwork_url: null,
  description: null,
  genre: 'Electronic',
  id,
  is_album: false,
  kind: 'playlist',
  permalink_url: `https://soundcloud.com/feelmybicep/sets/set-${id}`,
  published_at: '2023-12-20T23:58:59Z',
  release_date: null,
  set_type: '',
  title,
  track_count: tracks.length,
  tracks,
  user: BICEP,
  ...extra,
})

export const album = (id: number, title: string, tracks: unknown[]) => set(id, title, tracks, {
  is_album: true, set_type: 'album', release_date: '2024-04-28T00:00:00Z',
})
