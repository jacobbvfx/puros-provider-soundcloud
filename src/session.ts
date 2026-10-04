import { createHash } from 'node:crypto'
import { ProviderApiError, type ProviderSecretsHostV1 } from 'puros-provider-sdk'
import { apiError, type SoundCloudClient } from './api'
import { asId, asRecord, asString } from './json'

const SECRET_KEY = 'session'
const SESSION_VERSION = 1

export interface SoundCloudAccount {
  userId: string
  name: string
  permalink: string | null
}

interface StoredSession {
  version: typeof SESSION_VERSION
  token: string
  account: SoundCloudAccount
  importedAt: number
}

export type SessionState = 'signed-out' | 'connected' | 'expired'

function isStoredSession(value: unknown): value is StoredSession {
  const record = value as Partial<StoredSession> | null
  return !!record && record.version === SESSION_VERSION && typeof record.token === 'string' && record.token.length > 0
    && !!record.account && typeof record.account.userId === 'string' && typeof record.account.name === 'string'
}

/**
 * What a user pastes: the cookie value, optionally as `oauth_token=…`, an
 * `Authorization: OAuth …` header value, or wrapped in quotes.
 */
export function normalizeToken(input: string): string {
  let token = input.trim()
  token = token.replace(/^authorization\s*:\s*/i, '').replace(/^oauth\s+/i, '').replace(/^oauth_token\s*=\s*/i, '')
  token = token.replace(/;.*$/s, '').replace(/^["']|["']$/g, '').trim()
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(token)) {
    throw apiError('INVALID_ARGUMENT', 'That is not a SoundCloud oauth_token value. Copy the value of the oauth_token cookie only.')
  }
  return token
}

export function parseMe(value: unknown): SoundCloudAccount | null {
  const me = asRecord(value)
  const userId = asId(me?.id)
  const name = asString(me?.username)?.trim() ?? asString(me?.full_name)?.trim()
  if (!userId || !name) return null
  return { userId, name, permalink: asString(me?.permalink) }
}

/**
 * The signed-in SoundCloud session: one OAuth token, kept only in
 * `host.secrets` and this object's memory. Nothing about it is logged or
 * returned; the account name and profile permalink are shown in the status.
 */
export class SoundCloudSession {
  private session: StoredSession | null = null
  private expired = false
  private loaded = false
  private readonly listeners = new Set<() => void>()
  /** Secret writes and deletes in order, so a late save never revives a disconnected session. */
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly options: { secrets: ProviderSecretsHostV1; client: () => SoundCloudClient }) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* status listeners never break auth */ }
    }
  }

  /** Restore the saved session after a restart; a corrupt secret counts as signed out. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const raw = await this.options.secrets.get(SECRET_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isStoredSession(parsed)) this.session = parsed
    } catch {
      this.session = null
    }
  }

  getToken(): string | null {
    return this.expired ? null : this.session?.token ?? null
  }

  status(): { state: SessionState; account: SoundCloudAccount | null } {
    if (!this.session) return { state: 'signed-out', account: null }
    return { state: this.expired ? 'expired' : 'connected', account: this.session.account }
  }

  /** A stable, non-reversible key of the account for cache entries; `guest` when signed out. */
  accountKey(): string {
    const account = this.session && !this.expired ? this.session.account.userId : null
    return account ? `u${createHash('sha256').update(`soundcloud\0${account}`).digest('hex').slice(0, 16)}` : 'guest'
  }

  /** api-v2 refused the token: keep it for inspection, stop sending it. */
  markExpired(): void {
    if (!this.session || this.expired) return
    this.expired = true
    this.changed()
  }

  /** Check a token with a real `GET /me` and only then persist it. A rejected token leaves any existing session untouched. */
  async adopt(rawToken: string, signal?: AbortSignal): Promise<SoundCloudAccount> {
    const token = normalizeToken(rawToken)
    let me: unknown
    try {
      me = await this.options.client().request({ path: 'me', auth: 'required', token, signal })
    } catch (error) {
      if (error instanceof ProviderApiError && ['AUTH_EXPIRED', 'NOT_AUTHENTICATED', 'PERMISSION_DENIED'].includes(error.providerError.code)) {
        throw apiError('AUTH_EXPIRED', 'SoundCloud did not accept this token. Copy oauth_token again from a signed-in soundcloud.com tab.')
      }
      throw error
    }
    const account = parseMe(me)
    if (!account) throw apiError('AUTH_EXPIRED', 'SoundCloud answered without an account for this token')
    const session: StoredSession = { version: SESSION_VERSION, token, account, importedAt: Date.now() }
    await this.enqueueWrite(() => this.options.secrets.set(SECRET_KEY, JSON.stringify(session)))
    this.session = session
    this.expired = false
    this.loaded = true
    this.changed()
    return account
  }

  async logout(): Promise<void> {
    this.session = null
    this.expired = false
    this.loaded = true
    await this.enqueueWrite(() => this.options.secrets.delete(SECRET_KEY))
    this.changed()
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write)
    this.writes = next.catch(() => {})
    return next
  }
}
