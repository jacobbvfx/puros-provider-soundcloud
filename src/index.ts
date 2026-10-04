import manifestJson from '../provider.manifest.json'
import {
  API_VERSION,
  ProviderApiError,
  providerError,
  type ProviderAuthCollectDescriptorV1,
  type ProviderAuthLoginRequestV1,
  type ProviderAuthStatusV1,
  type ProviderHostV1,
  type ProviderLibraryRecordV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderRuntimeV1,
  type ProviderStatusV1,
} from 'puros-provider-sdk'
import { apiError, notAuthenticated, sessionExpired, SoundCloudClient } from './api'
import { SoundCloudCatalog } from './catalog'
import { fetchLibrarySnapshot, pageRecords, snapshotRecords } from './library'
import { artworkUrl, parseCredits, parseTrackDetails } from './parsers'
import { SoundCloudPlayback, type AudioSource } from './playback'
import { SoundCloudSession } from './session'

export const manifest = manifestJson as ProviderManifestV1

const SIGN_IN_URL = 'https://soundcloud.com/signin'
/** In memory: the host wipes it before the window opens and after it closes. */
const SIGN_IN_PARTITION = 'puros-provider-soundcloud'
const SIGN_IN_COLLECTION = manifest.permissions!.authCollections!.find((collection) => collection.id === 'soundcloud-sign-in')!
const CLIENT_ID_KEY = 'client-id'

async function createRuntime(host: ProviderHostV1): Promise<ProviderRuntimeV1> {
  let active = true
  let session!: SoundCloudSession
  const client = new SoundCloudClient({
    getToken: () => session.getToken(),
    onSessionRejected: () => session.markExpired(),
    clientIds: {
      async load() {
        const stored = await host.storage.get(CLIENT_ID_KEY)
        return typeof stored === 'string' && /^[0-9a-zA-Z]{32}$/.test(stored) ? stored : null
      },
      async save(clientId) {
        if (clientId) await host.storage.set(CLIENT_ID_KEY, clientId)
        else await host.storage.delete(CLIENT_ID_KEY)
      },
    },
  })
  session = new SoundCloudSession({ secrets: host.secrets, client: () => client })
  await session.load()
  const signedInUserId = () => session.status().state === 'connected' ? session.status().account!.userId : null
  const catalog = new SoundCloudCatalog(client, signedInUserId)
  const audioSource = async (): Promise<AudioSource> => (await host.settings.get('audio-source').catch(() => undefined)) === 'original' ? 'original' : 'stream'
  const playback = new SoundCloudPlayback({ host, session, client, catalog, audioSource })
  let source: AudioSource = 'stream'
  let librarySnapshot: { records: ProviderLibraryRecordV1[]; syncedAt: number } | null = null
  const sync = new AbortController()

  const ensureActive = () => {
    if (!active) throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'SoundCloud provider is inactive', { retryable: true }))
  }

  const authStatus = (): ProviderAuthStatusV1 => {
    const current = session.status()
    return {
      authenticated: current.state === 'connected',
      accountLabel: current.account?.name ?? null,
      message: current.state === 'expired' ? 'Sign-in expired — sign in again' : null,
    }
  }

  const status = (): ProviderStatusV1 => {
    const current = session.status()
    const account = current.state === 'connected'
      ? `Connected as ${current.account!.name}${current.account!.permalink ? ` (soundcloud.com/${current.account!.permalink})` : ''}`
      : current.state === 'expired' ? 'Sign-in expired — sign in again (public tracks still play)' : 'Not connected — public tracks play without an account'
    const playbackValue = source === 'original'
      ? 'Original upload when the artist allows downloads, otherwise the best stream'
      : 'Best stream SoundCloud offers (AAC or MP3, no transcoding)'
    return {
      state: active ? (current.state === 'expired' ? 'degraded' : 'ready') : 'inactive',
      authenticated: current.state === 'connected',
      updatedAt: Date.now(),
      ...(current.state === 'expired' ? { message: 'SoundCloud sign-in expired' } : {}),
      values: { account, playback: playbackValue },
    }
  }

  const emitStatus = async () => {
    if (!active) return
    await host.events.emit({ type: 'auth.changed', status: authStatus() }).catch(() => {})
    await host.events.emit({ type: 'status.changed', status: status() }).catch(() => {})
  }
  session.onChange(() => { void emitStatus() })

  // Housekeeping and a background check of the restored token; neither blocks activation.
  void (async () => {
    await playback.cleanupStaleFiles().catch(() => {})
    source = await audioSource()
    if (session.getToken()) {
      await client.request({ path: 'me', auth: 'required' }).catch((error) => {
        void host.logger.info('SoundCloud session check failed', {
          code: error instanceof ProviderApiError ? error.providerError.code : 'INTERNAL',
        }).catch(() => {})
      })
    }
    await emitStatus()
  })()

  const signIn = async (token: string) => {
    await playback.cancelAll()
    librarySnapshot = null
    await session.adopt(token)
    await emitStatus()
    return { status: authStatus() }
  }

  return {
    capabilities: {
      auth: {
        async getStatus() { ensureActive(); return authStatus() },
        async login(request?: ProviderAuthLoginRequestV1) {
          ensureActive()
          if (request?.form === 'connect' && request.values && typeof request.values === 'object') {
            const token = typeof request.values['oauth-token'] === 'string' ? request.values['oauth-token'] : ''
            if (!token.trim()) throw apiError('INVALID_ARGUMENT', 'Paste the value of the oauth_token cookie')
            return signIn(token)
          }
          if (request?.step === 'browser') {
            const result = await host.openAuthWindow({
              url: SIGN_IN_URL,
              partition: SIGN_IN_PARTITION,
              allowedOrigins: [...SIGN_IN_COLLECTION.allowedOrigins],
              collect: SIGN_IN_COLLECTION.values.map((value) => ({ ...value }) as ProviderAuthCollectDescriptorV1),
              userAgent: 'browser',
            })
            const token = result.completed ? result.values['oauth-token'] : undefined
            if (!token) throw apiError('CANCELLED', 'The SoundCloud sign-in window was closed before signing in', true)
            return signIn(token)
          }
          throw apiError('INVALID_ARGUMENT', 'Use "Sign in with SoundCloud" or "Connect with a token"')
        },
        async logout() {
          ensureActive()
          await playback.cancelAll()
          librarySnapshot = null
          await session.logout()
          await emitStatus()
        },
      },
      'catalog.search': {
        async search(request) { ensureActive(); return catalog.search(request) },
      },
      'catalog.entities': {
        async getArtist(sourceId) { ensureActive(); return catalog.getArtist(sourceId) },
        async getArtistBundle(sourceId) { ensureActive(); return catalog.getArtistBundle(sourceId) },
        async getAlbum(sourceId) { ensureActive(); return catalog.getAlbum(sourceId) },
        async getAlbumBundle(sourceId) { ensureActive(); return catalog.getAlbumBundle(sourceId) },
        async getTrack(sourceId) {
          ensureActive()
          const stored = await host.catalog.getStoredTrack(sourceId)
          if (stored) return stored
          return catalog.getTrack(sourceId)
        },
      },
      'catalog.home': {
        async getShelves(request) { ensureActive(); return catalog.getShelves(request?.cursor) },
        async getCollection(request) { ensureActive(); return catalog.getCollection(request) },
      },
      'library.sync': {
        async enumerate(request) {
          ensureActive()
          const current = session.status()
          if (current.state === 'expired') throw sessionExpired()
          const userId = signedInUserId()
          if (!userId) throw notAuthenticated()
          if (!request.cursor) {
            librarySnapshot = null
            const snapshot = await fetchLibrarySnapshot(client, catalog, userId, async (processed, label) => {
              await host.events.emit({ type: 'library.sync.progress', processed, label }).catch(() => {})
            }, sync.signal)
            await host.logger.info('SoundCloud library fetched', {
              likedTracks: snapshot.likedTracks.length, followings: snapshot.followings.length,
              albums: snapshot.albums.length, playlists: snapshot.playlists.length,
            }).catch(() => {})
            librarySnapshot = { records: snapshotRecords(snapshot), syncedAt: Math.floor(Date.now() / 1000) }
          }
          if (!librarySnapshot) throw apiError('INVALID_ARGUMENT', 'The SoundCloud library cursor has expired', true)
          const page = pageRecords(librarySnapshot.records, request.cursor ? Number(request.cursor) : 0, request.limit, librarySnapshot.syncedAt)
          await host.events.emit({
            type: 'library.sync.progress',
            processed: Number(page.nextCursor ?? librarySnapshot.records.length),
            total: librarySnapshot.records.length,
            label: 'Importing SoundCloud library',
          }).catch(() => {})
          if (page.complete) librarySnapshot = null
          return page
        },
      },
      playlists: {
        async list(request) { ensureActive(); return catalog.listLibraryPlaylists(request?.cursor) },
        async get(sourceId) { ensureActive(); return catalog.getPlaylistInfo(sourceId) },
        async getTracks(sourceId, request) { ensureActive(); return catalog.getPlaylistTracks(sourceId, request?.cursor) },
      },
      'playback.resolve': {
        async resolve(request) {
          ensureActive()
          source = await audioSource()
          return playback.resolve(request)
        },
      },
      'playback.prefetch': {
        async prefetch(request) { ensureActive(); return playback.prefetch(request) },
      },
      'metadata.artwork': {
        async getDisplayArtworkUrl(url) { ensureActive(); return artworkUrl(url) },
        async getArtwork(ref) {
          ensureActive()
          const url = ref.entityType === 'artist' ? (await catalog.getArtist(ref.sourceId)).artworkUrl
            : ref.entityType === 'album' ? (await catalog.getAlbum(ref.sourceId)).artworkUrl
              : ref.entityType === 'playlist' ? (await catalog.getPlaylistInfo(ref.sourceId)).artworkUrl
                : (await catalog.getTrack(ref.sourceId)).artworkUrl
          return url ? { url } : null
        },
      },
      'metadata.bio': {
        async getBio(ref) {
          ensureActive()
          if (ref.entityType !== 'artist') return null
          const artist = await catalog.getArtist(ref.sourceId)
          return artist.bio ? { text: artist.bio, ...(artist.bioUrl ? { sourceUrl: artist.bioUrl } : {}) } : null
        },
      },
      'metadata.credits': {
        async getCredits(ref) {
          ensureActive()
          if (ref.entityType === 'track') return parseCredits(await catalog.getTrackObject(ref.sourceId))
          if (ref.entityType === 'album') {
            const album = await catalog.getAlbum(ref.sourceId)
            return (album.artists ?? []).map((credit) => ({ name: credit.artistName, role: credit.role, artistSourceId: credit.artistSourceId ?? null, position: credit.position }))
          }
          return []
        },
        async getTrackDetails(sourceId) {
          ensureActive()
          return parseTrackDetails(await catalog.getTrackObject(sourceId))
        },
      },
    },
    async getStatus() { return status() },
    async cancelSession(sessionId) { return playback.cancelSession(sessionId) },
    async deactivate() {
      active = false
      librarySnapshot = null
      sync.abort()
      await playback.shutdown()
    },
  }
}

const plugin: ProviderPluginV1 = {
  apiVersion: API_VERSION,
  manifest,
  async activate(host) {
    await host.logger.info('SoundCloud plugin activated')
    return createRuntime(host)
  },
}

export default plugin
