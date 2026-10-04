import { ProviderApiError, providerError } from 'puros-provider-sdk'

/**
 * Source IDs are SoundCloud's numeric IDs as decimal strings, unchanged:
 * tracks `tracks/{id}`, artists `users/{id}`, albums and playlists
 * `playlists/{id}` (albums are playlists with an album `set_type`).
 * Generated collections (mixes, track stations) are system-playlist URNs.
 */
const NUMERIC_ID = /^[1-9]\d{0,19}$/
const SYSTEM_PLAYLIST_URN = /^soundcloud:system-playlists:[A-Za-z0-9:_-]{1,200}$/

export const isNumericId = (value: unknown): value is string => typeof value === 'string' && NUMERIC_ID.test(value)
export const isSystemPlaylistUrn = (value: unknown): value is string => typeof value === 'string' && SYSTEM_PLAYLIST_URN.test(value)

function notFound(kind: string): ProviderApiError {
  return new ProviderApiError(providerError('NOT_FOUND', `SoundCloud ${kind} not found`, { retryable: false }))
}

export function requireTrackId(value: string): string {
  if (!isNumericId(value)) throw notFound('track')
  return value
}

export function requireUserId(value: string): string {
  if (!isNumericId(value)) throw notFound('artist')
  return value
}

export function requirePlaylistId(value: string, kind: 'album' | 'playlist' = 'playlist'): string {
  if (!isNumericId(value)) throw notFound(kind)
  return value
}

/** A playlist ID or a system-playlist URN (mixes, stations). */
export function requireCollectionId(value: string): string {
  if (!isNumericId(value) && !isSystemPlaylistUrn(value)) throw notFound('playlist')
  return value
}

/** Station of one track, as api-v2 names it in `station_urn`. */
export const trackStationUrn = (trackId: string) => `soundcloud:system-playlists:track-stations:${trackId}`
