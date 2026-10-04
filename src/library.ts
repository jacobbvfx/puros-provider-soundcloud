import {
  ProviderApiError,
  type ProviderAlbumV1,
  type ProviderArtistV1,
  type ProviderLibraryRecordV1,
  type ProviderLibrarySyncPageV1,
  type ProviderPlaylistV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'
import { apiError, type SoundCloudClient } from './api'
import type { SoundCloudCatalog } from './catalog'
import { asId, asRecord } from './json'
import { embeddedTracks, isAlbumSet, parseAlbum, parseArtist, parseLike, parsePlaylist, parseTrack, setTrackIds } from './parsers'

/** Bounds that stop a runaway sync; reaching one fails the sync instead of truncating it. */
const MAX_PAGES_PER_LIST = 250
const MAX_SETS = 1_000

export interface LibrarySnapshot {
  likedTracks: ProviderTrackV1[]
  followings: ProviderArtistV1[]
  albums: Array<{ album: ProviderAlbumV1; tracks: ProviderTrackV1[] }>
  playlists: Array<{ playlist: ProviderPlaylistV1; tracks: ProviderTrackV1[] }>
}

type Progress = (processed: number, label: string) => Promise<void>

/**
 * Fetch the whole account library: liked tracks, liked and own albums, liked
 * and own playlists (each with every track), and followed artists. Any failed
 * page aborts the snapshot, so a partial library is never reported complete.
 */
export async function fetchLibrarySnapshot(
  client: SoundCloudClient,
  catalog: SoundCloudCatalog,
  userId: string,
  progress: Progress,
  signal?: AbortSignal,
): Promise<LibrarySnapshot> {
  const all = (path: string) => client.collectAll({ path, auth: 'required', signal, maxPages: MAX_PAGES_PER_LIST })

  const likes = await all(`users/${userId}/likes`)
  const likedTracks: ProviderTrackV1[] = []
  const likedSets: unknown[] = []
  for (const like of likes) {
    const parsed = parseLike(like)
    if (parsed?.type === 'track') {
      const track = parseTrack(parsed.value)
      if (track) likedTracks.push(track)
    } else if (parsed?.type === 'playlist') {
      likedSets.push(parsed.value)
    }
  }
  await progress(likedTracks.length, 'Fetching SoundCloud likes')

  const ownPlaylists = await all(`users/${userId}/playlists_without_albums`)
  const ownAlbums = await all(`users/${userId}/albums`)
  const followings = (await all(`users/${userId}/followings`)).flatMap((user) => parseArtist(user) ?? [])
  await progress(likedTracks.length + followings.length, 'Fetching SoundCloud followings')

  // Own sets first, so a set that is both owned and liked keeps its owner's listing.
  const sets = new Map<string, unknown>()
  for (const set of [...ownAlbums, ...ownPlaylists, ...likedSets]) {
    const id = asId(asRecord(set)?.id)
    if (id && !sets.has(id)) sets.set(id, set)
  }
  if (sets.size > MAX_SETS) throw apiError('INTERNAL', 'The SoundCloud library has more playlists and albums than Puros syncs')

  const albums: LibrarySnapshot['albums'] = []
  const playlists: LibrarySnapshot['playlists'] = []
  let index = 0
  for (const [id, listed] of sets) {
    // Listings embed at most a few tracks; the set itself names all of them.
    let set: unknown
    try {
      set = await client.request({ path: `playlists/${id}`, auth: 'required', signal })
    } catch (error) {
      // A liked set its owner deleted or made private is gone, not a failed page: leave it out.
      if (error instanceof ProviderApiError && ['NOT_FOUND', 'PERMISSION_DENIED'].includes(error.providerError.code)) {
        index += 1
        continue
      }
      throw error
    }
    if (isAlbumSet(set) || isAlbumSet(listed)) {
      const album = parseAlbum(set)
      if (!album) throw apiError('INTERNAL', 'SoundCloud returned an unreadable album')
      const tracks = await catalog.hydrateTracks(setTrackIds(set), embeddedTracks(set), (position) => ({
        albumSourceId: album.sourceId, albumTitle: album.title, trackNumber: position + 1,
      }), signal)
      albums.push({ album: { ...album, totalTracks: album.totalTracks ?? tracks.length }, tracks })
    } else {
      const playlist = parsePlaylist(set)
      if (!playlist) throw apiError('INTERNAL', 'SoundCloud returned an unreadable playlist')
      playlists.push({ playlist, tracks: await catalog.hydrateTracks(setTrackIds(set), embeddedTracks(set), undefined, signal) })
    }
    index += 1
    await progress(likedTracks.length + followings.length + index, 'Fetching SoundCloud playlists and albums')
  }
  return { likedTracks, followings, albums, playlists }
}

/** Flatten a snapshot into v1 records: entities first, then playlists and their ordered memberships. */
export function snapshotRecords(snapshot: LibrarySnapshot): ProviderLibraryRecordV1[] {
  const artists = new Map<string, ProviderArtistV1>()
  const albums = new Map<string, ProviderAlbumV1>()
  const tracks = new Map<string, ProviderTrackV1>()
  const liked = new Set(snapshot.likedTracks.map((track) => track.sourceId))

  const addCreditedArtists = (credits: ProviderTrackV1['artists']) => {
    for (const credit of credits ?? []) {
      if (!credit.artistSourceId || artists.has(credit.artistSourceId)) continue
      artists.set(credit.artistSourceId, { sourceId: credit.artistSourceId, name: credit.artistName, genres: [], inLibrary: false })
    }
  }
  const addTrack = (track: ProviderTrackV1) => {
    const existing = tracks.get(track.sourceId)
    // A track met on an album keeps that album and position, wherever else it appears.
    const base = existing?.albumSourceId ? existing : track.albumSourceId ? track : (existing ?? track)
    tracks.set(track.sourceId, { ...base, inLibrary: liked.has(track.sourceId) })
    addCreditedArtists(track.artists)
  }

  for (const artist of snapshot.followings) artists.set(artist.sourceId, { ...artist, inLibrary: true })
  for (const { album, tracks: members } of snapshot.albums) {
    albums.set(album.sourceId, { ...album, inLibrary: true })
    addCreditedArtists(album.artists)
    for (const track of members) addTrack(track)
  }
  for (const track of snapshot.likedTracks) addTrack(track)
  for (const { tracks: members } of snapshot.playlists) for (const track of members) addTrack(track)

  const records: ProviderLibraryRecordV1[] = [
    ...[...artists.values()].map((value) => ({ type: 'artist' as const, value })),
    ...[...albums.values()].map((value) => ({ type: 'album' as const, value })),
    ...[...tracks.values()].map((value) => ({ type: 'track' as const, value })),
  ]
  for (const { playlist, tracks: members } of snapshot.playlists) {
    records.push({ type: 'playlist', value: { ...playlist, trackCount: playlist.trackCount ?? members.length } })
    members.forEach((track, position) => {
      records.push({ type: 'playlistTrack', value: { playlistSourceId: playlist.sourceId, trackSourceId: track.sourceId, position } })
    })
  }
  return records
}

export function pageRecords(records: ProviderLibraryRecordV1[], offset: number, limit: number | undefined, syncedAt: number): ProviderLibrarySyncPageV1 {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) throw new TypeError('Invalid library cursor')
  const size = Number.isInteger(limit) && limit! > 0 ? Math.min(500, limit!) : 100
  const end = Math.min(records.length, offset + size)
  const complete = end === records.length
  return {
    records: records.slice(offset, end),
    nextCursor: complete ? null : String(end),
    complete,
    ...(complete ? { checkpoint: syncedAt } : {}),
  }
}
