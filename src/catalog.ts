import {
  ProviderApiError,
  type ProviderAlbumBundleV1,
  type ProviderAlbumV1,
  type ProviderArtistBundleV1,
  type ProviderArtistV1,
  type ProviderEntityTypeV1,
  type ProviderHomeCollectionV1,
  type ProviderHomeShelfV1,
  type ProviderPageV1,
  type ProviderPlaylistV1,
  type ProviderSearchRequestV1,
  type ProviderSearchResultsV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'
import { apiError, cursorKey, decodeCursor, encodeCursor, notAuthenticated, type SoundCloudClient } from './api'
import { TRACK_BATCH_SIZE } from './constants'
import { isSystemPlaylistUrn, requireCollectionId, requirePlaylistId, requireTrackId, requireUserId } from './ids'
import { asArray, asRecord, asString } from './json'
import {
  embeddedTracks,
  parseAlbum,
  parseArtist,
  parsePlaylist,
  parseSelections,
  parseSystemPlaylist,
  parseTrack,
  setTrackIds,
  type TrackContext,
} from './parsers'

const MAX_QUERY_LENGTH = 200
const COLLECTION_TRACK_LIMIT = 500
const PLAYLIST_PAGE_SIZE = 100

type SearchKind = 'tracks' | 'users' | 'albums' | 'playlists'
const SEARCH_PATHS: Record<SearchKind, string> = {
  tracks: 'search/tracks',
  users: 'search/users',
  albums: 'search/albums',
  playlists: 'search/playlists_without_albums',
}

function searchKinds(types: ProviderEntityTypeV1[] | undefined): SearchKind[] {
  const wanted = new Set(types && types.length > 0 ? types : ['track', 'album', 'artist', 'playlist'])
  return [
    ...(wanted.has('track') ? ['tracks' as const] : []),
    ...(wanted.has('artist') ? ['users' as const] : []),
    ...(wanted.has('album') ? ['albums' as const] : []),
    ...(wanted.has('playlist') ? ['playlists' as const] : []),
  ]
}

/** Search cursors: the next page address of each result kind, without the client ID. */
function encodeSearchCursor(next: Partial<Record<SearchKind, string>>): string | null {
  return Object.keys(next).length > 0 ? Buffer.from(JSON.stringify(next)).toString('base64url') : null
}

function decodeSearchCursor(cursor: string): Partial<Record<SearchKind, string>> {
  let value: unknown
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { value = null }
  const record = asRecord(value)
  if (!record || Object.keys(record).length === 0) throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud page cursor')
  const next: Partial<Record<SearchKind, string>> = {}
  for (const [key, href] of Object.entries(record)) {
    if (!(key in SEARCH_PATHS) || typeof href !== 'string') throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud page cursor')
    next[key as SearchKind] = decodeCursor(Buffer.from(href).toString('base64url'), SEARCH_PATHS[key as SearchKind])!
  }
  return next
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof ProviderApiError && ['AUTH_EXPIRED', 'NOT_AUTHENTICATED'].includes(error.providerError.code)
}

/**
 * Catalog reads. Public SoundCloud works signed out; with a session the same
 * requests also see the account's private sets and Go+ stream variants.
 */
export class SoundCloudCatalog {
  constructor(
    private readonly client: SoundCloudClient,
    private readonly signedInUserId: () => string | null,
  ) {}

  private get(path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal) {
    return this.client.request({ path, query, auth: 'optional', signal })
  }

  /**
   * Full track objects for `ids`, in order. Sets embed only their first few
   * tracks; the rest are stubs fetched 50 at a time. IDs SoundCloud no longer
   * returns (deleted, private) are left out.
   */
  async hydrateTracks(ids: string[], embedded: Map<string, unknown> = new Map(), context?: (index: number) => TrackContext, signal?: AbortSignal): Promise<ProviderTrackV1[]> {
    const objects = new Map(embedded)
    const missing = [...new Set(ids.filter((id) => !objects.has(id)))]
    for (let offset = 0; offset < missing.length; offset += TRACK_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + TRACK_BATCH_SIZE)
      const response = await this.get('tracks', { ids: batch.join(',') }, signal)
      for (const track of asArray(response)) {
        const id = asRecord(track)?.id
        if (id !== undefined) objects.set(String(id), track)
      }
    }
    return ids.flatMap((id, index) => parseTrack(objects.get(id), context?.(index)) ?? [])
  }

  async search(request: ProviderSearchRequestV1): Promise<ProviderSearchResultsV1> {
    const query = request.query.trim().slice(0, MAX_QUERY_LENGTH)
    const cursor = request.cursor ? decodeSearchCursor(request.cursor) : null
    if (!query && !cursor) throw apiError('INVALID_ARGUMENT', 'Enter something to search for')
    const limit = Math.max(1, Math.min(50, request.limit ?? 20))
    const kinds = cursor ? (Object.keys(cursor) as SearchKind[]) : searchKinds(request.types)
    const pages = await Promise.all(kinds.map(async (kind) => ({
      kind,
      page: cursor
        ? await this.client.page({ path: cursor[kind]!, auth: 'optional' })
        : await this.client.page({ path: SEARCH_PATHS[kind], query: { q: query }, limit, auth: 'optional' }),
    })))
    const results: ProviderSearchResultsV1 = { artists: [], albums: [], tracks: [], playlists: [], nextCursor: null }
    const next: Partial<Record<SearchKind, string>> = {}
    for (const { kind, page } of pages) {
      for (const item of page.collection) {
        if (kind === 'tracks') { const track = parseTrack(item); if (track) results.tracks.push(track) }
        else if (kind === 'users') { const artist = parseArtist(item); if (artist) results.artists.push(artist) }
        else if (kind === 'albums') { const album = parseAlbum(item); if (album) results.albums.push(album) }
        else { const playlist = parsePlaylist(item); if (playlist) results.playlists.push(playlist) }
      }
      if (page.nextHref && page.collection.length > 0) next[kind] = cursorKey(page.nextHref)
    }
    results.nextCursor = encodeSearchCursor(next)
    return results
  }

  async getArtist(sourceId: string): Promise<ProviderArtistV1> {
    const artist = parseArtist(await this.get(`users/${requireUserId(sourceId)}`))
    if (!artist) throw apiError('NOT_FOUND', 'SoundCloud artist not found')
    return artist
  }

  async getArtistBundle(sourceId: string): Promise<ProviderArtistBundleV1> {
    const id = requireUserId(sourceId)
    // The profile must load; the shelves around it are best effort.
    const optional = async (path: string, limit: number) => {
      try {
        return (await this.client.page({ path, limit, auth: 'optional' })).collection
      } catch (error) {
        if (isAuthFailure(error)) throw error
        return []
      }
    }
    const [artist, topTracks, albums, playlists, related] = await Promise.all([
      this.getArtist(id),
      optional(`users/${id}/toptracks`, 20),
      optional(`users/${id}/albums`, 50),
      optional(`users/${id}/playlists_without_albums`, 50),
      optional(`users/${id}/relatedartists`, 20),
    ])
    return {
      artist,
      releases: albums.flatMap((album) => parseAlbum(album) ?? []),
      playlists: playlists.flatMap((playlist) => parsePlaylist(playlist) ?? []),
      topTracks: topTracks.flatMap((track) => parseTrack(track) ?? []),
      relatedArtists: related.flatMap((user) => parseArtist(user) ?? []).filter((user) => user.sourceId !== id),
    }
  }

  async getAlbum(sourceId: string): Promise<ProviderAlbumV1> {
    const album = parseAlbum(await this.get(`playlists/${requirePlaylistId(sourceId, 'album')}`))
    if (!album) throw apiError('NOT_FOUND', 'SoundCloud album not found')
    return album
  }

  async getAlbumBundle(sourceId: string, signal?: AbortSignal): Promise<ProviderAlbumBundleV1> {
    const set = await this.get(`playlists/${requirePlaylistId(sourceId, 'album')}`, undefined, signal)
    const album = parseAlbum(set)
    if (!album) throw apiError('NOT_FOUND', 'SoundCloud album not found')
    const tracks = await this.hydrateTracks(setTrackIds(set), embeddedTracks(set), (index) => ({
      albumSourceId: album.sourceId, albumTitle: album.title, trackNumber: index + 1,
    }), signal)
    return { album: { ...album, totalTracks: album.totalTracks ?? tracks.length }, tracks }
  }

  /** The raw track object (playback needs its transcodings and `track_authorization`). */
  async getTrackObject(sourceId: string, signal?: AbortSignal): Promise<unknown> {
    return this.get(`tracks/${requireTrackId(sourceId)}`, undefined, signal)
  }

  async getTrack(sourceId: string): Promise<ProviderTrackV1> {
    const track = parseTrack(await this.getTrackObject(sourceId))
    if (!track) throw apiError('NOT_FOUND', 'SoundCloud track not found')
    return track
  }

  async getShelves(cursor?: string | null): Promise<ProviderPageV1<ProviderHomeShelfV1>> {
    const next = decodeCursor(cursor, 'mixed-selections')
    const response = await this.client.request({ path: next ?? 'mixed-selections', query: next ? undefined : { limit: 10 }, auth: 'optional' })
    // Selection URNs are unique and stable across pages.
    const shelves = parseSelections(response).map((selection) => ({
      id: selection.id.replace(/[^A-Za-z0-9:_-]+/g, '-').slice(0, 120),
      title: selection.title,
      kind: 'playlists' as const,
      items: selection.items,
    }))
    const href = asString(asRecord(response)?.next_href)
    return { items: shelves, nextCursor: shelves.length > 0 ? encodeCursor(href) : null }
  }

  /** A set or a system playlist (mix, station) as a home collection. */
  async getCollection(request: { type: 'playlist' | 'mix' | 'station'; sourceId: string; limit?: number }): Promise<ProviderHomeCollectionV1> {
    const id = requireCollectionId(request.sourceId)
    const limit = Math.min(COLLECTION_TRACK_LIMIT, Math.max(1, request.limit ?? COLLECTION_TRACK_LIMIT))
    const set = await this.get(isSystemPlaylistUrn(id) ? `system-playlists/${id}` : `playlists/${id}`)
    const info = isSystemPlaylistUrn(id) ? parseSystemPlaylist(set) : parsePlaylist(set)
    if (!info) throw apiError('NOT_FOUND', 'SoundCloud playlist not found')
    const tracks = await this.hydrateTracks(setTrackIds(set).slice(0, limit), embeddedTracks(set))
    return { title: info.title, subtitle: info.description ?? null, artworkUrl: info.artworkUrl ?? tracks[0]?.artworkUrl ?? null, tracks }
  }

  // ---- playlists capability ----

  /** The signed-in account's own playlists (albums are listed as releases, not here). */
  async listLibraryPlaylists(cursor?: string | null): Promise<ProviderPageV1<ProviderPlaylistV1>> {
    const userId = this.signedInUserId()
    if (!userId) throw notAuthenticated()
    const next = decodeCursor(cursor, `users/${userId}/playlists_without_albums`)
    const page = next
      ? await this.client.page({ path: next, auth: 'required' })
      : await this.client.page({ path: `users/${userId}/playlists_without_albums`, limit: 50, auth: 'required' })
    return {
      items: page.collection.flatMap((playlist) => parsePlaylist(playlist) ?? []),
      nextCursor: page.collection.length > 0 ? encodeCursor(page.nextHref) : null,
    }
  }

  async getPlaylistInfo(sourceId: string): Promise<ProviderPlaylistV1> {
    const id = requireCollectionId(sourceId)
    const set = await this.get(isSystemPlaylistUrn(id) ? `system-playlists/${id}` : `playlists/${id}`)
    const playlist = isSystemPlaylistUrn(id) ? parseSystemPlaylist(set) : parsePlaylist(set)
    if (!playlist) throw apiError('NOT_FOUND', 'SoundCloud playlist not found')
    return playlist
  }

  /** Playlist tracks in pages of 100; the cursor is the offset into the set's track list. */
  async getPlaylistTracks(sourceId: string, cursor?: string | null): Promise<ProviderPageV1<ProviderTrackV1>> {
    const id = requireCollectionId(sourceId)
    const offset = cursor ? Number(cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud page cursor')
    const set = await this.get(isSystemPlaylistUrn(id) ? `system-playlists/${id}` : `playlists/${id}`)
    const ids = setTrackIds(set)
    const end = Math.min(ids.length, offset + PLAYLIST_PAGE_SIZE)
    const items = await this.hydrateTracks(ids.slice(offset, end), embeddedTracks(set))
    return { items, nextCursor: end < ids.length ? String(end) : null }
  }
}
