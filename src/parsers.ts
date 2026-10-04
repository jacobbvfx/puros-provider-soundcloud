import type {
  ProviderAlbumV1,
  ProviderArtistCreditV1,
  ProviderArtistV1,
  ProviderCreditV1,
  ProviderPlaylistV1,
  ProviderReleaseTypeV1,
  ProviderTrackDetailsV1,
  ProviderTrackV1,
} from 'puros-provider-sdk'
import { isSystemPlaylistUrn } from './ids'
import { asArray, asId, asNumber, asRecord, asString, yearOf, type JsonRecord } from './json'

/** Renditions are named by a suffix before the extension (`-large.jpg`, `-t500x500.jpg`, `-original.png`). */
const ARTWORK_SUFFIX = /-(?:[0-9a-z]+)\.(?:jpg|jpeg|png)$/i
const DEFAULT_AVATAR = /\/images\/default_avatar/

/**
 * The 500 px JPEG rendition of an sndcdn.com image (the web player's largest
 * fixed size). Other URLs pass through unchanged; default avatars count as none.
 */
export function artworkUrl(value: unknown, size: 't500x500' | 'original' = 't500x500'): string | null {
  const text = asString(value)
  if (!text) return null
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  url.protocol = 'https:'
  if (!/(^|\.)sndcdn\.com$/.test(url.hostname)) return url.toString()
  if (DEFAULT_AVATAR.test(url.pathname)) return null
  if (ARTWORK_SUFFIX.test(url.pathname)) {
    const extension = size === 'original' ? url.pathname.match(/\.(jpg|jpeg|png)$/i)![1] : 'jpg'
    url.pathname = url.pathname.replace(ARTWORK_SUFFIX, `-${size}.${extension}`)
  }
  url.search = ''
  return url.toString()
}

/** Only links to soundcloud.com itself become `providerUrl`. */
export function soundcloudUrl(value: unknown): string | null {
  const text = asString(value)
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' && (url.hostname === 'soundcloud.com' || url.hostname === 'm.soundcloud.com') ? url.toString() : null
  } catch {
    return null
  }
}

export function normalizeIsrc(value: unknown): string | null {
  const text = asString(value)?.replace(/[\s-]/g, '').toUpperCase()
  return text && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(text) ? text : null
}

export function normalizeUpc(value: unknown): string | null {
  const text = asString(value)?.replace(/\s/g, '') ?? (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null)
  return text && /^\d{12,14}$/.test(text) ? text : null
}

interface UserRef { sourceId: string; name: string }

function userRef(value: unknown): UserRef | null {
  const user = asRecord(value)
  const sourceId = asId(user?.id)
  const name = asString(user?.username)?.trim()
  return sourceId && name ? { sourceId, name } : null
}

function credit(user: UserRef | null): ProviderArtistCreditV1[] {
  return user ? [{ artistSourceId: user.sourceId, artistName: user.name, role: 'primary', position: 0 }] : []
}

function genres(value: unknown): string[] {
  const genre = asString(value)?.trim()
  return genre ? [genre] : []
}

/** A user as an artist. SoundCloud artists are accounts: the uploader is the credited artist. */
export function parseArtist(value: unknown): ProviderArtistV1 | null {
  const user = asRecord(value)
  const ref = userRef(user)
  if (!user || !ref) return null
  const description = asString(user.description)?.trim() ?? null
  const providerUrl = soundcloudUrl(user.permalink_url)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    artworkUrl: artworkUrl(user.avatar_url),
    bio: description,
    bioUrl: description ? providerUrl : null,
    genres: [],
    providerUrl,
    trackCount: asNumber(user.track_count),
  }
}

export interface TrackContext {
  albumSourceId?: string | null
  albumTitle?: string | null
  trackNumber?: number | null
}

/**
 * A full track object. Playlist "stubs" (only `id`, `kind`, `policy`) have no
 * title and yield null; callers hydrate them through `tracks?ids=` first.
 */
export function parseTrack(value: unknown, context: TrackContext = {}): ProviderTrackV1 | null {
  const track = asRecord(value)
  const sourceId = asId(track?.id)
  const title = asString(track?.title)?.trim()
  if (!track || !sourceId || !title || (track.kind !== undefined && track.kind !== 'track')) return null
  const user = userRef(track.user)
  const publisher = asRecord(track.publisher_metadata)
  return {
    sourceId,
    title,
    isrc: normalizeIsrc(publisher?.isrc),
    upc: normalizeUpc(publisher?.upc_or_ean),
    durationMs: Math.max(0, Math.round(asNumber(track.full_duration) ?? asNumber(track.duration) ?? 0)),
    trackNumber: context.trackNumber ?? null,
    discNumber: null,
    albumSourceId: context.albumSourceId ?? null,
    // The label's album title, when the uploader supplied publisher metadata; nothing is invented.
    albumTitle: context.albumTitle ?? asString(publisher?.album_title)?.trim() ?? null,
    primaryArtistSourceId: user?.sourceId ?? null,
    primaryArtistName: user?.name ?? null,
    artists: credit(user),
    genres: genres(track.genre),
    artworkUrl: artworkUrl(track.artwork_url) ?? artworkUrl(asRecord(track.user)?.avatar_url),
    providerUrl: soundcloudUrl(track.permalink_url),
  }
}

const RELEASE_TYPES: Record<string, ProviderReleaseTypeV1> = {
  album: 'album', ep: 'ep', single: 'single', compilation: 'compilation',
}

/** Albums are playlists marked as a release (`is_album` or an album `set_type`). */
export function isAlbumSet(value: unknown): boolean {
  const set = asRecord(value)
  if (!set) return false
  const type = asString(set.set_type)?.toLowerCase()
  return set.is_album === true || (!!type && type in RELEASE_TYPES)
}

function setArtwork(set: JsonRecord): string | null {
  const firstTrack = asArray(set.tracks).map(asRecord).find((track) => asString(track?.artwork_url))
  return artworkUrl(set.artwork_url) ?? artworkUrl(set.calculated_artwork_url) ?? artworkUrl(firstTrack?.artwork_url)
}

export function parseAlbum(value: unknown): ProviderAlbumV1 | null {
  const set = asRecord(value)
  const sourceId = asId(set?.id)
  const title = asString(set?.title)?.trim()
  if (!set || !sourceId || !title) return null
  const user = userRef(set.user)
  const type = asString(set.set_type)?.toLowerCase()
  return {
    sourceId,
    title,
    year: yearOf(set.release_date) ?? yearOf(set.published_at),
    releaseType: (type && RELEASE_TYPES[type]) || 'album',
    artworkUrl: setArtwork(set),
    primaryArtistSourceId: user?.sourceId ?? null,
    primaryArtistName: user?.name ?? null,
    artists: credit(user),
    genres: genres(set.genre),
    totalTracks: asNumber(set.track_count),
    totalDiscs: null,
    providerUrl: soundcloudUrl(set.permalink_url),
  }
}

export function parsePlaylist(value: unknown): ProviderPlaylistV1 | null {
  const set = asRecord(value)
  if (!set) return null
  if (set.kind === 'system-playlist') return parseSystemPlaylist(set)
  const sourceId = asId(set.id)
  const title = asString(set.title)?.trim()
  if (!sourceId || !title) return null
  return {
    sourceId,
    title,
    description: asString(set.description)?.trim() ?? null,
    artworkUrl: setArtwork(set),
    trackCount: asNumber(set.track_count),
    providerUrl: soundcloudUrl(set.permalink_url),
    editable: false,
    collectionRef: { type: 'playlist', sourceId },
  }
}

/** Generated collections (mixes, "Trending", track and artist stations). */
export function parseSystemPlaylist(value: unknown): ProviderPlaylistV1 | null {
  const set = asRecord(value)
  const urn = asString(set?.urn)
  const title = asString(set?.title)?.trim() ?? asString(set?.short_title)?.trim()
  if (!set || !isSystemPlaylistUrn(urn) || !title) return null
  const station = /:(?:track|artist)-stations:/.test(urn)
  return {
    sourceId: urn,
    title,
    description: (asString(set.description) ?? asString(set.short_description))?.trim() ?? null,
    artworkUrl: setArtwork(set),
    trackCount: asArray(set.tracks).length || null,
    providerUrl: soundcloudUrl(set.permalink_url),
    editable: false,
    collectionRef: { type: station ? 'station' : 'mix', sourceId: urn },
  }
}

/** Track IDs of a set in order, including stubs that still need hydrating. */
export function setTrackIds(value: unknown): string[] {
  return asArray(asRecord(value)?.tracks).flatMap((track) => asId(asRecord(track)?.id) ?? [])
}

/** Full track objects already embedded in a set, by ID. */
export function embeddedTracks(value: unknown): Map<string, unknown> {
  const tracks = new Map<string, unknown>()
  for (const track of asArray(asRecord(value)?.tracks)) {
    const record = asRecord(track)
    const id = asId(record?.id)
    if (id && asString(record?.title)) tracks.set(id, record)
  }
  return tracks
}

/** One item of `users/{id}/likes`: `{ track }` or `{ playlist }` (albums are playlists too). */
export function parseLike(value: unknown): { type: 'track'; value: unknown } | { type: 'playlist'; value: unknown } | null {
  const item = asRecord(value)
  if (asRecord(item?.track)) return { type: 'track', value: item!.track }
  if (asRecord(item?.playlist)) return { type: 'playlist', value: item!.playlist }
  return null
}

/** Shelves of `mixed-selections`: their playlists, albums and system playlists as openable collections. */
export function parseSelections(value: unknown): Array<{ id: string; title: string; items: ProviderPlaylistV1[] }> {
  return asArray(asRecord(value)?.collection).flatMap((entry) => {
    const selection = asRecord(entry)
    const title = asString(selection?.title)?.trim()
    if (!selection || !title) return []
    const items = asArray(asRecord(selection.items)?.collection).flatMap((item) => parsePlaylist(item) ?? [])
    if (items.length === 0) return []
    const id = asString(selection.urn) ?? asString(selection.id) ?? title
    return [{ id, title, items }]
  })
}

/** Credits SoundCloud states for a track: the uploader and, when supplied, publisher metadata. */
export function parseCredits(value: unknown): ProviderCreditV1[] {
  const track = asRecord(value)
  const user = userRef(track?.user)
  const publisher = asRecord(track?.publisher_metadata)
  const credits: ProviderCreditV1[] = user ? [{ name: user.name, role: 'primary', artistSourceId: user.sourceId, position: 0 }] : []
  const performer = asString(publisher?.artist)?.trim()
  if (performer && performer.toLowerCase() !== user?.name.toLowerCase()) credits.push({ name: performer, role: 'performer', position: credits.length })
  const writers = asString(publisher?.writer_composer)?.trim()
  if (writers) credits.push({ name: writers, role: 'composer', position: credits.length })
  return credits
}

export function parseTrackDetails(value: unknown): ProviderTrackDetailsV1 | null {
  const track = asRecord(value)
  const sourceId = asId(track?.id)
  if (!track || !sourceId) return null
  const publisher = asRecord(track.publisher_metadata)
  const roles: ProviderTrackDetailsV1['roles'] = []
  const add = (role: string, text: unknown) => {
    const name = asString(text)?.trim()
    if (name) roles.push({ role, contributors: [name] })
  }
  add('Artist', publisher?.artist)
  add('Writer/Composer', publisher?.writer_composer)
  add('Publisher', publisher?.publisher)
  const releaseDate = asString(track.release_date)?.slice(0, 10) ?? null
  return {
    sourceId,
    providerUrl: soundcloudUrl(track.permalink_url),
    albumTitle: asString(publisher?.album_title)?.trim() ?? null,
    releaseDate: releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? releaseDate : null,
    label: asString(track.label_name)?.trim() ?? null,
    copyright: (asString(publisher?.c_line) ?? asString(publisher?.p_line))?.trim() ?? null,
    isrc: normalizeIsrc(publisher?.isrc),
    upc: normalizeUpc(publisher?.upc_or_ean),
    roles,
  }
}
