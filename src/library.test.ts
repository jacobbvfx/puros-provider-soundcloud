import { describe, expect, it } from 'vitest'
import { SoundCloudCatalog } from './catalog'
import { GLUE, album, set, stub, track, user } from './fixtures'
import { fetchLibrarySnapshot, pageRecords, snapshotRecords } from './library'
import { fakeSoundCloud, json, testClient } from './testing'

const ME = 183
const page = (collection: unknown[]) => () => json({ collection, next_href: null })

function library(overrides: Record<string, Parameters<typeof fakeSoundCloud>[0][string]> = {}) {
  const liked = track(1, 'Liked')
  const inAlbum = track(2, 'Album Opener')
  const routes: Parameters<typeof fakeSoundCloud>[0] = {
    [`users/${ME}/likes`]: () => json({
      collection: [
        { kind: 'like', track: liked },
        { kind: 'like', track: inAlbum },
        { kind: 'like', playlist: set(30, 'Liked playlist', [stub(1)]) },
        { kind: 'like', playlist: set(40, 'Deleted playlist', []) },
      ],
      next_href: null,
    }),
    [`users/${ME}/playlists_without_albums`]: page([set(10, 'Mine', [GLUE])]),
    [`users/${ME}/albums`]: page([album(20, 'Isles', [inAlbum])]),
    [`users/${ME}/followings`]: page([user(5, 'Four Tet')]),
    'playlists/10': () => json(set(10, 'Mine', [GLUE, stub(3), stub(1)])),
    'playlists/20': () => json(album(20, 'Isles', [inAlbum, stub(4)])),
    'playlists/30': () => json(set(30, 'Liked playlist', [stub(1)])),
    'playlists/40': () => json({}, 404),
    tracks: (url) => json((url.searchParams.get('ids') ?? '').split(',').map((id) => track(Number(id), `Track ${id}`))),
    ...overrides,
  }
  const api = fakeSoundCloud(routes)
  const client = testClient(api.fetch, { token: () => 'tok' })
  return { api, client, catalog: new SoundCloudCatalog(client, () => String(ME)) }
}

describe('fetchLibrarySnapshot', () => {
  it('collects likes, own and liked sets with every track, and followings', async () => {
    const { client, catalog, api } = library()
    const progress: string[] = []
    const snapshot = await fetchLibrarySnapshot(client, catalog, String(ME), async (_n, label) => { progress.push(label) })
    expect(snapshot.likedTracks.map((t) => t.sourceId)).toEqual(['1', '2'])
    expect(snapshot.followings.map((a) => a.name)).toEqual(['Four Tet'])
    expect(snapshot.albums).toHaveLength(1)
    expect(snapshot.albums[0].tracks.map((t) => [t.sourceId, t.albumSourceId, t.trackNumber])).toEqual([['2', '20', 1], ['4', '20', 2]])
    expect(snapshot.playlists.map((p) => [p.playlist.sourceId, p.tracks.map((t) => t.sourceId)])).toEqual([
      ['10', ['336067387', '3', '1']],
      ['30', ['1']],
    ])
    // Stubs are hydrated in batches, never one request per track.
    expect(api.requests.filter((r) => r.url.pathname === '/tracks').every((r) => r.url.searchParams.get('ids')!.split(',').length <= 50)).toBe(true)
    expect(api.requests.every((r) => r.authorization === 'OAuth tok')).toBe(true)
    expect(progress[progress.length - 1]).toBe('Fetching SoundCloud playlists and albums')
  })

  it('fails the whole snapshot when any page fails', async () => {
    const { client, catalog } = library({ 'playlists/30': () => json({}, 500) })
    await expect(fetchLibrarySnapshot(client, catalog, String(ME), async () => {})).rejects.toMatchObject({ providerError: { code: 'NETWORK' } })
  })
})

describe('snapshotRecords', () => {
  it('marks liked tracks and followed artists, keeps album context and playlist order', async () => {
    const { client, catalog } = library()
    const records = snapshotRecords(await fetchLibrarySnapshot(client, catalog, String(ME), async () => {}))
    const tracks = new Map(records.filter((r) => r.type === 'track').map((r) => [r.value.sourceId, r.value]))
    expect(tracks.get('1')).toMatchObject({ inLibrary: true })
    expect(tracks.get('3')).toMatchObject({ inLibrary: false })
    expect(tracks.get('2')).toMatchObject({ inLibrary: true, albumSourceId: '20', trackNumber: 1 })
    const artists = records.filter((r) => r.type === 'artist').map((r) => [r.value.sourceId, (r.value as { inLibrary?: boolean }).inLibrary])
    expect(artists).toEqual(expect.arrayContaining([['5', true], ['92661', false]]))
    expect(records.filter((r) => r.type === 'album').map((r) => r.value.sourceId)).toEqual(['20'])
    const memberships = records.filter((r) => r.type === 'playlistTrack').map((r) => r.value)
    expect(memberships.filter((m) => m.playlistSourceId === '10').map((m) => [m.trackSourceId, m.position])).toEqual([['336067387', 0], ['3', 1], ['1', 2]])
    // Entities precede the playlists that reference them.
    const firstPlaylist = records.findIndex((r) => r.type === 'playlist')
    expect(records.slice(firstPlaylist).every((r) => r.type === 'playlist' || r.type === 'playlistTrack')).toBe(true)
  })

  it('pages records with a checkpoint only on the last page', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ type: 'artist' as const, value: { sourceId: String(i + 1), name: `A${i}` } }))
    expect(pageRecords(records, 0, 2, 9)).toMatchObject({ nextCursor: '2', complete: false })
    expect(pageRecords(records, 4, 2, 9)).toMatchObject({ nextCursor: null, complete: true, checkpoint: 9 })
    expect(() => pageRecords(records, 6, 2, 9)).toThrow()
  })
})
