import { ProviderApiError, providerError, type ProviderErrorCodeV1 } from 'puros-provider-sdk'
import { API_BASE_URL, API_HOST, ASSET_SCRIPT_PATTERN, CLIENT_ID_PATTERN, MAX_PAGE_SIZE, USER_AGENT, WEB_ORIGIN } from './constants'
import { asArray, asRecord, asString } from './json'

export type AuthMode = 'required' | 'optional' | 'none'

export interface ApiRequest {
  /** Path relative to api-v2 (`tracks/1`) or an absolute api-v2 URL (`next_href`, transcoding URLs). */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  auth: AuthMode
  signal?: AbortSignal
  /** Override the session token (sign-in verification uses one that is not saved yet). */
  token?: string
  /**
   * Endpoints whose 401/403 mean "not for you" rather than a bad client ID or
   * session (the original download): map them to PERMISSION_DENIED as is.
   */
  plainErrors?: boolean
}

export interface ClientIdStore {
  load(): Promise<string | null>
  save(clientId: string | null): Promise<void>
}

export interface SoundCloudClientOptions {
  fetch?: typeof fetch
  getToken(): string | null
  /** api-v2 refused the session token. */
  onSessionRejected?(): void
  clientIds: ClientIdStore
  timeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface CollectionPage {
  collection: unknown[]
  nextHref: string | null
}

/** A rejected client ID is re-scraped at most this often, so a 403 on one private track never floods soundcloud.com. */
const CLIENT_ID_REFRESH_INTERVAL_MS = 60_000

export function apiError(code: ProviderErrorCodeV1, message: string, retryable = false, retryAfterMs?: number): ProviderApiError {
  return new ProviderApiError(providerError(code, message, { retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }))
}

export function notAuthenticated(): ProviderApiError {
  return apiError('NOT_AUTHENTICATED', 'Connect SoundCloud in Settings → Accounts')
}

export function sessionExpired(): ProviderApiError {
  return apiError('AUTH_EXPIRED', 'Your SoundCloud sign-in has expired or was signed out. Sign in again in Settings → Accounts → SoundCloud.')
}

/** Only https api-v2 URLs are ever requested; a `next_href` pointing elsewhere is rejected. */
export function apiUrl(pathOrUrl: string): URL {
  let url: URL
  try {
    url = new URL(pathOrUrl, API_BASE_URL)
  } catch {
    throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud API address')
  }
  if (url.protocol !== 'https:' || url.hostname !== API_HOST || url.username || url.password) {
    throw apiError('INVALID_ARGUMENT', 'SoundCloud returned an address outside its API')
  }
  return url
}

/** The `client_id` embedded in one of the web app's asset scripts (the newest scripts are listed last). */
export async function scrapeClientId(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/javascript,*/*' }
  const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000))
  let page: string
  try {
    const response = await fetchImpl(`${WEB_ORIGIN}/`, { headers, signal: timeout() })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    page = await response.text()
  } catch {
    throw apiError('NETWORK', 'soundcloud.com is unreachable', true)
  }
  const scripts = [...page.matchAll(ASSET_SCRIPT_PATTERN)].map((match) => match[1]).reverse().slice(0, 16)
  for (const script of scripts) {
    try {
      const response = await fetchImpl(script, { headers, signal: timeout() })
      if (!response.ok) continue
      const match = (await response.text()).match(CLIENT_ID_PATTERN)
      if (match) return match[1]
    } catch {
      if (signal?.aborted) throw apiError('CANCELLED', 'SoundCloud request cancelled', true)
    }
  }
  throw apiError('PROVIDER_UNAVAILABLE', 'Could not find the SoundCloud web client ID; SoundCloud may have changed its web app', true)
}

/**
 * Minimal api-v2 client, the way the soundcloud.com web app calls it: every
 * request carries the web app's public `client_id`; signed-in requests add
 * `Authorization: OAuth <token>`. The token is never logged or returned.
 */
export class SoundCloudClient {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private clientId: Promise<string> | null = null
  private lastRefresh = -Infinity

  constructor(private readonly options: SoundCloudClientOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  private currentClientId(signal?: AbortSignal): Promise<string> {
    this.clientId ??= (async () => {
      const stored = await this.options.clientIds.load().catch(() => null)
      if (stored) return stored
      const scraped = await scrapeClientId(this.fetchImpl, signal)
      await this.options.clientIds.save(scraped).catch(() => {})
      return scraped
    })()
    const pending = this.clientId
    pending.catch(() => { if (this.clientId === pending) this.clientId = null })
    return pending
  }

  /** Replace a rejected client ID once (single flight); false when it was refreshed too recently. */
  private async refreshClientId(rejected: string, signal?: AbortSignal): Promise<boolean> {
    const current = await this.clientId?.catch(() => null)
    if (current && current !== rejected) return true
    if (this.now() - this.lastRefresh < CLIENT_ID_REFRESH_INTERVAL_MS) return false
    this.lastRefresh = this.now()
    await this.options.clientIds.save(null).catch(() => {})
    this.clientId = null
    this.clientId = (async () => {
      const scraped = await scrapeClientId(this.fetchImpl, signal)
      await this.options.clientIds.save(scraped).catch(() => {})
      return scraped
    })()
    await this.clientId
    return true
  }

  async request(request: ApiRequest): Promise<unknown> {
    const token = request.auth === 'none' ? null : (request.token ?? this.options.getToken())
    if (request.auth === 'required' && !token) throw notAuthenticated()
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 3)
    let refreshed = false
    for (let attempt = 1; ; attempt += 1) {
      if (request.signal?.aborted) throw apiError('CANCELLED', 'SoundCloud request cancelled', true)
      const clientId = await this.currentClientId(request.signal)
      try {
        return await this.once(request, clientId, token, refreshed)
      } catch (error) {
        if (error instanceof ClientIdRejected) {
          if (!refreshed && await this.refreshClientId(clientId, request.signal)) {
            refreshed = true
            attempt -= 1
            continue
          }
          throw error.final()
        }
        const typed = error instanceof ProviderApiError ? error.providerError : null
        if (!typed?.retryable || typed.code === 'CANCELLED' || attempt >= maxAttempts) throw error
        await this.sleep(typed.retryAfterMs ?? 500 * 2 ** (attempt - 1))
      }
    }
  }

  private async once(request: ApiRequest, clientId: string, token: string | null, refreshed: boolean): Promise<unknown> {
    const url = apiUrl(request.path)
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    url.searchParams.set('client_id', clientId)
    const headers: Record<string, string> = {
      Accept: 'application/json; charset=utf-8',
      'User-Agent': USER_AGENT,
      Origin: WEB_ORIGIN,
      Referer: `${WEB_ORIGIN}/`,
    }
    if (token) headers.Authorization = `OAuth ${token}`
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' })
    } catch (error) {
      if (request.signal?.aborted) throw apiError('CANCELLED', 'SoundCloud request cancelled', true)
      if (timeout.aborted) throw apiError('TIMEOUT', 'SoundCloud did not respond in time', true)
      throw apiError('NETWORK', `SoundCloud is unreachable (${error instanceof Error ? error.name : 'network error'})`, true)
    }
    const status = response.status
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => {})
      if (request.plainErrors) throw apiError('PERMISSION_DENIED', 'SoundCloud does not allow this for the signed-in account')
      const final = () => status === 403
        ? apiError('PERMISSION_DENIED', 'SoundCloud does not allow access to this item (private, removed or not available in your country)')
        // A token being verified (`request.token`) is not the saved session: its rejection expires nothing.
        : token ? (request.token ? sessionExpired() : this.rejectSession()) : apiError('PROVIDER_UNAVAILABLE', 'SoundCloud rejected the web client ID', true)
      // The client ID rotates with SoundCloud web releases: replace it once before believing the answer.
      if (!refreshed) throw new ClientIdRejected(final)
      throw final()
    }
    if (status === 429) {
      await response.body?.cancel().catch(() => {})
      const retryAfter = Number(response.headers.get('retry-after'))
      throw apiError('RATE_LIMITED', 'SoundCloud is rate limiting requests; try again shortly', true,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10_000)
    }
    if (status === 404) {
      await response.body?.cancel().catch(() => {})
      throw apiError('NOT_FOUND', 'SoundCloud has no such item')
    }
    if (status >= 500) {
      await response.body?.cancel().catch(() => {})
      throw apiError('NETWORK', `SoundCloud server error (HTTP ${status})`, true)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw apiError(status === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL', `SoundCloud rejected the request (HTTP ${status})`)
    }
    try {
      return await response.json()
    } catch {
      throw apiError('INTERNAL', 'SoundCloud returned an unreadable response', true)
    }
  }

  private rejectSession(): ProviderApiError {
    this.options.onSessionRejected?.()
    return sessionExpired()
  }

  /** One `linked_partitioning` page: its items and the next page's address. */
  async page(request: Omit<ApiRequest, 'query'> & { query?: ApiRequest['query']; limit?: number }): Promise<CollectionPage> {
    const isContinuation = /^https:/.test(request.path)
    const query = isContinuation ? request.query : {
      limit: Math.max(1, Math.min(MAX_PAGE_SIZE, request.limit ?? MAX_PAGE_SIZE)),
      linked_partitioning: 1,
      ...request.query,
    }
    const body = asRecord(await this.request({ ...request, query }))
    if (!body || !Array.isArray(body.collection)) throw apiError('INTERNAL', 'SoundCloud returned an unexpected page', true)
    const next = asString(body.next_href)
    return { collection: asArray(body.collection), nextHref: next ? apiUrl(next).toString() : null }
  }

  /**
   * Every page of a collection. Fails instead of truncating: a page limit that
   * is reached or a cursor that repeats throws, so a partial list is never
   * mistaken for a complete one.
   */
  async collectAll(request: Omit<ApiRequest, 'query'> & { query?: ApiRequest['query']; maxPages?: number }): Promise<unknown[]> {
    const items: unknown[] = []
    const seen = new Set<string>()
    let page = await this.page(request)
    for (let count = 1; ; count += 1) {
      items.push(...page.collection)
      if (!page.nextHref) return items
      const key = cursorKey(page.nextHref)
      if (seen.has(key)) throw apiError('INTERNAL', 'SoundCloud pagination did not advance', true)
      if (count >= (request.maxPages ?? 250)) throw apiError('INTERNAL', 'SoundCloud collection exceeds the page limit')
      seen.add(key)
      page = await this.page({ ...request, path: page.nextHref, query: undefined })
    }
  }
}

/** A 401/403 to judge only after the client ID was replaced (judging it may expire the session). */
class ClientIdRejected extends Error {
  constructor(readonly final: () => ProviderApiError) {
    super('SoundCloud rejected the request')
  }
}

/** A `next_href` without its client ID, for loop detection and opaque cursors. */
export function cursorKey(href: string): string {
  const url = apiUrl(href)
  url.searchParams.delete('client_id')
  return `${url.pathname}?${url.searchParams.toString()}`
}

export function encodeCursor(href: string | null): string | null {
  return href ? Buffer.from(cursorKey(href)).toString('base64url') : null
}

/** A cursor this provider issued for `pathPrefix`; anything else is rejected. */
export function decodeCursor(cursor: string | null | undefined, pathPrefix: string): string | null {
  if (!cursor) return null
  let href: string
  try {
    href = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud page cursor')
  }
  const url = apiUrl(href)
  if (!url.pathname.startsWith(`/${pathPrefix}`)) throw apiError('INVALID_ARGUMENT', 'Invalid SoundCloud page cursor')
  return url.toString()
}
