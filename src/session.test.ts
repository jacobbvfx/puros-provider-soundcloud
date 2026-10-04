import { describe, expect, it, vi } from 'vitest'
import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import { normalizeToken, SoundCloudSession } from './session'
import { fakeSoundCloud, json, testClient } from './testing'

function secrets(): ProviderSecretsHostV1 & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async has(key) { return values.has(key) },
    async get(key) { return values.get(key) },
    async set(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
}

describe('normalizeToken', () => {
  it('accepts the cookie value however it was copied', () => {
    expect(normalizeToken('2-123456-123456789-AbCdEf')).toBe('2-123456-123456789-AbCdEf')
    expect(normalizeToken('  "2-123456-123456789-AbCdEf"\n')).toBe('2-123456-123456789-AbCdEf')
    expect(normalizeToken('oauth_token=2-123456-123456789-AbCdEf; sc_anonymous_id=1')).toBe('2-123456-123456789-AbCdEf')
    expect(normalizeToken('Authorization: OAuth 2-123456-123456789-AbCdEf')).toBe('2-123456-123456789-AbCdEf')
  })

  it('rejects anything else without echoing it', () => {
    expect(() => normalizeToken('short')).toThrow(/not a SoundCloud oauth_token/)
    expect(() => normalizeToken('two words here')).toThrow()
  })
})

describe('SoundCloudSession', () => {
  const me = { id: 183, username: 'Forss', permalink: 'forss' }

  it('saves a token only after /me accepts it, and restores it', async () => {
    const api = fakeSoundCloud({ me: (_url, request) => request.authorization === 'OAuth 2-1-2-good' ? json(me) : json({}, 401) })
    const store = secrets()
    let session!: SoundCloudSession
    const client = testClient(api.fetch, { token: () => session.getToken() })
    session = new SoundCloudSession({ secrets: store, client: () => client })
    const changed = vi.fn()
    session.onChange(changed)
    await expect(session.adopt('2-1-2-good')).resolves.toEqual({ userId: '183', name: 'Forss', permalink: 'forss' })
    expect(session.status().state).toBe('connected')
    expect(session.accountKey()).toMatch(/^u[0-9a-f]{16}$/)
    expect(changed).toHaveBeenCalled()

    const restored = new SoundCloudSession({ secrets: store, client: () => client })
    await restored.load()
    expect(restored.getToken()).toBe('2-1-2-good')
    expect(JSON.stringify([...store.values.values()])).not.toContain('password')
  })

  it('keeps the previous session when a new token is refused', async () => {
    const api = fakeSoundCloud({ me: (_url, request) => request.authorization === 'OAuth 2-1-2-good' ? json(me) : json({}, 401) })
    const store = secrets()
    let session!: SoundCloudSession
    const client = testClient(api.fetch, { token: () => session.getToken(), onSessionRejected: () => session.markExpired() })
    session = new SoundCloudSession({ secrets: store, client: () => client })
    await session.adopt('2-1-2-good')
    await expect(session.adopt('2-1-2-bad')).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    expect(session.status().state).toBe('connected')
    expect(session.getToken()).toBe('2-1-2-good')
  })

  it('stops sending an expired token and forgets everything on logout', async () => {
    const store = secrets()
    const api = fakeSoundCloud({ me: () => json(me) })
    let session!: SoundCloudSession
    const client = testClient(api.fetch, { token: () => session.getToken() })
    session = new SoundCloudSession({ secrets: store, client: () => client })
    await session.adopt('2-1-2-good')
    session.markExpired()
    expect(session.getToken()).toBeNull()
    expect(session.accountKey()).toBe('guest')
    expect(session.status().state).toBe('expired')
    await session.logout()
    expect(store.values.size).toBe(0)
    expect(session.status()).toEqual({ state: 'signed-out', account: null })
  })

  it('treats a corrupt secret as signed out', async () => {
    const store = secrets()
    store.values.set('session', '{not json')
    const session = new SoundCloudSession({ secrets: store, client: () => testClient(fakeSoundCloud({}).fetch) })
    await session.load()
    expect(session.status().state).toBe('signed-out')
  })
})
