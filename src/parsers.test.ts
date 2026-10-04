import { describe, expect, it } from 'vitest'
import { BICEP, GLUE, GLUE_PUBLISHER, album, set, stub, track, user } from './fixtures'
import {
  artworkUrl,
  embeddedTracks,
  isAlbumSet,
  parseAlbum,
  parseArtist,
  parseCredits,
  parseLike,
  parsePlaylist,
  parseSelections,
  parseTrack,
  parseTrackDetails,
  setTrackIds,
} from './parsers'

describe('artworkUrl', () => {
  it('asks sndcdn for the 500 px rendition', () => {
    expect(artworkUrl('https://i1.sndcdn.com/artworks-000236453388-128osm-large.jpg')).toBe('https://i1.sndcdn.com/artworks-000236453388-128osm-t500x500.jpg')
    expect(artworkUrl('https://i1.sndcdn.com/artworks-x-original.png', 'original')).toBe('https://i1.sndcdn.com/artworks-x-original.png')
    expect(artworkUrl('https://i1.sndcdn.com/artworks-x-t500x500.png')).toBe('https://i1.sndcdn.com/artworks-x-t500x500.jpg')
  })

  it('treats default avatars and junk as no artwork', () => {
    expect(artworkUrl('https://a1.sndcdn.com/images/default_avatar_large.png')).toBeNull()
    expect(artworkUrl('javascript:alert(1)')).toBeNull()
    expect(artworkUrl(null)).toBeNull()
  })
})

describe('parseTrack', () => {
  it('maps a track with publisher metadata, crediting the uploader', () => {
    expect(parseTrack(GLUE)).toEqual({
      sourceId: '336067387',
      title: 'BICEP | GLUE // CLIP',
      isrc: 'GBCFB1700229',
      upc: '5054429119862',
      durationMs: 103_453,
      trackNumber: null,
      discNumber: null,
      albumSourceId: null,
      albumTitle: 'Bicep',
      primaryArtistSourceId: '92661',
      primaryArtistName: 'BICEP',
      artists: [{ artistSourceId: '92661', artistName: 'BICEP', role: 'primary', position: 0 }],
      genres: ['Electronic'],
      artworkUrl: 'https://i1.sndcdn.com/artworks-336067387-128osm-t500x500.jpg',
      providerUrl: 'https://soundcloud.com/feelmybicep/track-336067387',
    })
  })

  it('falls back to the uploader avatar and applies album context', () => {
    const parsed = parseTrack(track(5, 'Five', { artwork_url: null }), { albumSourceId: '9', albumTitle: 'Nine', trackNumber: 3 })
    expect(parsed).toMatchObject({ artworkUrl: 'https://i1.sndcdn.com/avatars-92661-abc-t500x500.jpg', albumSourceId: '9', albumTitle: 'Nine', trackNumber: 3 })
  })

  it('rejects stubs, other kinds and malformed identifiers', () => {
    expect(parseTrack(stub(5))).toBeNull()
    expect(parseTrack({ ...GLUE, kind: 'playlist' })).toBeNull()
    expect(parseTrack({ ...GLUE, id: -1 })).toBeNull()
    expect(parseTrack(track(1, 'x', { publisher_metadata: { isrc: 'not-an-isrc', upc_or_ean: '12' } }))).toMatchObject({ isrc: null, upc: null })
  })
})

describe('artists, albums and playlists', () => {
  it('maps a user as an artist with their bio', () => {
    expect(parseArtist(BICEP)).toMatchObject({
      sourceId: '92661', name: 'BICEP', bio: 'BOOKING\n\nAmericas: …', bioUrl: 'https://soundcloud.com/bicep',
      artworkUrl: 'https://i1.sndcdn.com/avatars-92661-abc-t500x500.jpg', trackCount: 423,
    })
    expect(parseArtist(user(1, 'x', { description: '   ' }))).toMatchObject({ bio: null, bioUrl: null })
  })

  it('tells albums from playlists', () => {
    const release = album(1, 'Isles', [GLUE])
    expect(isAlbumSet(release)).toBe(true)
    expect(isAlbumSet(set(2, 'Mix', []))).toBe(false)
    expect(isAlbumSet(set(3, 'EP', [], { set_type: 'ep' }))).toBe(true)
    expect(parseAlbum(release)).toMatchObject({
      sourceId: '1', title: 'Isles', year: 2024, releaseType: 'album', totalTracks: 1,
      primaryArtistSourceId: '92661', artworkUrl: 'https://i1.sndcdn.com/artworks-336067387-128osm-t500x500.jpg',
    })
  })

  it('maps playlists with an openable collection ref and keeps stub order', () => {
    const playlist = set(2050462, 'Favourites', [GLUE, stub(7), stub(8)])
    expect(parsePlaylist(playlist)).toMatchObject({ sourceId: '2050462', trackCount: 3, editable: false, collectionRef: { type: 'playlist', sourceId: '2050462' } })
    expect(setTrackIds(playlist)).toEqual(['336067387', '7', '8'])
    expect([...embeddedTracks(playlist).keys()]).toEqual(['336067387'])
  })

  it('maps system playlists as mixes or stations', () => {
    const trending = { kind: 'system-playlist', urn: 'soundcloud:system-playlists:trending-by-genre:trap', title: 'Trap', tracks: [stub(1), stub(2)], artwork_url: null, calculated_artwork_url: 'https://i1.sndcdn.com/artworks-a-b-large.jpg', permalink_url: 'https://soundcloud.com/discover/sets/trending-by-genre:trap' }
    expect(parsePlaylist(trending)).toMatchObject({ sourceId: trending.urn, trackCount: 2, collectionRef: { type: 'mix', sourceId: trending.urn } })
    const station = { ...trending, urn: 'soundcloud:system-playlists:track-stations:336067387', title: 'Based on Glue' }
    expect(parsePlaylist(station)?.collectionRef?.type).toBe('station')
    expect(parsePlaylist({ ...trending, urn: 'soundcloud:users:1' })).toBeNull()
  })

  it('reads likes and selections', () => {
    expect(parseLike({ created_at: 'x', kind: 'like', track: GLUE })?.type).toBe('track')
    expect(parseLike({ created_at: 'x', kind: 'like', playlist: set(1, 'x', []) })?.type).toBe('playlist')
    expect(parseLike({ kind: 'like' })).toBeNull()
    const selections = parseSelections({ collection: [
      { kind: 'selection', urn: 'soundcloud:selections:curated', title: 'Curated by SoundCloud', items: { collection: [set(1, 'One', []), album(2, 'Two', [])] } },
      { kind: 'selection', urn: 'soundcloud:selections:empty', title: 'Empty', items: { collection: [] } },
    ] })
    expect(selections).toHaveLength(1)
    expect(selections[0].items.map((item) => item.collectionRef)).toEqual([{ type: 'playlist', sourceId: '1' }, { type: 'playlist', sourceId: '2' }])
  })
})

describe('credits and details', () => {
  it('lists the uploader, a differing performer and the writers', () => {
    const credits = parseCredits({ ...GLUE, publisher_metadata: { ...GLUE_PUBLISHER, artist: 'Bicep feat. Someone' } })
    expect(credits).toEqual([
      { name: 'BICEP', role: 'primary', artistSourceId: '92661', position: 0 },
      { name: 'Bicep feat. Someone', role: 'performer', position: 1 },
      { name: 'Bicep', role: 'composer', position: 2 },
    ])
    expect(parseCredits(GLUE).map((credit) => credit.role)).toEqual(['primary', 'composer'])
  })

  it('reads the label and codes for the details panel', () => {
    expect(parseTrackDetails(GLUE)).toMatchObject({ sourceId: '336067387', label: 'Ninja Tune', isrc: 'GBCFB1700229', upc: '5054429119862', albumTitle: 'Bicep' })
  })
})
