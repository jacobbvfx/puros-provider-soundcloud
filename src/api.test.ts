import { describe, expect, it, vi } from 'vitest'
import { ProviderApiError } from 'puros-provider-sdk'
import { apiUrl, decodeCursor, encodeCursor, scrapeClientId } from './api'
import { CLIENT_ID_A, CLIENT_ID_B, fakeSoundCloud, json, testClient } from './testing'

const code = (error: unknown) => (error as ProviderApiError).providerError.code

describe('client ID', () => {
  it('is scraped from the newest asset script', async () => {
    const api = fakeSoundCloud({})
    await expect(scrapeClientId(api.fetch)).resolves.toBe(CLIENT_ID_A)
  })

  it('goes on every request, with the OAuth token only when signed in', async () => {
    const api = fakeSoundCloud({ 'tracks/1': () => json({ id: 1 }) })
    const client = testClient(api.fetch, { token: () => 'tok' })
    await client.request({ path: 'tracks/1', auth: 'optional' })
    await client.request({ path: 'tracks/1', auth: 'none' })
    expect(api.requests.map((r) => [r.url.searchParams.get('client_id'), r.authorization])).toEqual([
      [CLIENT_ID_A, 'OAuth tok'], [CLIENT_ID_A, null],
    ])
    expect(api.scrapes()).toBe(1)
  })

  it('is replaced once when api-v2 rejects it, then the request is repeated', async () => {
    const api = fakeSoundCloud({
      'tracks/1': (url) => url.searchParams.get('client_id') === CLIENT_ID_B ? json({ id: 1 }) : json({}, 401),
    }, { clientIds: [CLIENT_ID_A, CLIENT_ID_B] })
    const rejected = vi.fn()
    const client = testClient(api.fetch, { token: () => null, onSessionRejected: rejected })
    await expect(client.request({ path: 'tracks/1', auth: 'optional' })).resolves.toEqual({ id: 1 })
    expect(api.scrapes()).toBe(2)
    expect(rejected).not.toHaveBeenCalled()
  })
})

describe('errors', () => {
  it('expires the session only when a fresh client ID is refused with the token too', async () => {
    const api = fakeSoundCloud({ me: () => json({}, 401) }, { clientIds: [CLIENT_ID_A, CLIENT_ID_B] })
    const rejected = vi.fn()
    const client = testClient(api.fetch, { token: () => 'tok', onSessionRejected: rejected })
    const error = await client.request({ path: 'me', auth: 'required' }).catch((e) => e)
    expect(code(error)).toBe('AUTH_EXPIRED')
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(api.requests).toHaveLength(2)
  })

  it('never expires the saved session for a token that is only being verified', async () => {
    const api = fakeSoundCloud({ me: () => json({}, 401) }, { clientIds: [CLIENT_ID_A, CLIENT_ID_B] })
    const rejected = vi.fn()
    const client = testClient(api.fetch, { token: () => 'saved', onSessionRejected: rejected })
    expect(code(await client.request({ path: 'me', auth: 'required', token: 'candidate' }).catch((e) => e))).toBe('AUTH_EXPIRED')
    expect(rejected).not.toHaveBeenCalled()
  })

  it('maps 403 to PERMISSION_DENIED and rescrapes at most once a minute', async () => {
    let now = 0
    const api = fakeSoundCloud({ 'tracks/2': () => json({}, 403) })
    const client = testClient(api.fetch, { now: () => now })
    expect(code(await client.request({ path: 'tracks/2', auth: 'optional' }).catch((e) => e))).toBe('PERMISSION_DENIED')
    expect(code(await client.request({ path: 'tracks/2', auth: 'optional' }).catch((e) => e))).toBe('PERMISSION_DENIED')
    expect(api.scrapes()).toBe(2)
    now = 61_000
    await client.request({ path: 'tracks/2', auth: 'optional' }).catch(() => {})
    expect(api.scrapes()).toBe(3)
  })

  it('reports original-download refusals as they are', async () => {
    const api = fakeSoundCloud({ 'tracks/3/download': () => json({}, 401) })
    const rejected = vi.fn()
    const client = testClient(api.fetch, { token: () => 'tok', onSessionRejected: rejected })
    expect(code(await client.request({ path: 'tracks/3/download', auth: 'required', plainErrors: true }).catch((e) => e))).toBe('PERMISSION_DENIED')
    expect(rejected).not.toHaveBeenCalled()
    expect(api.scrapes()).toBe(1)
  })

  it('retries rate limiting and server errors, not 404', async () => {
    let calls = 0
    const api = fakeSoundCloud({
      'tracks/4': () => (calls += 1) === 1 ? json({}, 429, { 'retry-after': '1' }) : calls === 2 ? json({}, 503) : json({ id: 4 }),
      'tracks/5': () => json({}, 404),
    })
    const client = testClient(api.fetch)
    await expect(client.request({ path: 'tracks/4', auth: 'none' })).resolves.toEqual({ id: 4 })
    expect(code(await client.request({ path: 'tracks/5', auth: 'none' }).catch((e) => e))).toBe('NOT_FOUND')
  })

  it('refuses addresses outside api-v2 and requires a session where asked', async () => {
    expect(() => apiUrl('https://evil.example/tracks')).toThrow()
    expect(() => apiUrl('http://api-v2.soundcloud.com/tracks')).toThrow()
    const client = testClient(fakeSoundCloud({}).fetch)
    expect(code(await client.request({ path: 'me', auth: 'required' }).catch((e) => e))).toBe('NOT_AUTHENTICATED')
  })
})

describe('pages', () => {
  it('follows next_href and fails on a repeating cursor', async () => {
    const api = fakeSoundCloud({
      'users/1/likes': (url) => {
        const offset = url.searchParams.get('offset')
        if (!offset) return json({ collection: [1, 2], next_href: 'https://api-v2.soundcloud.com/users/1/likes?offset=c1&limit=200' })
        return json({ collection: [3], next_href: null })
      },
      'users/2/likes': () => json({ collection: [1], next_href: 'https://api-v2.soundcloud.com/users/2/likes?offset=same' }),
      'users/3/likes': () => json({ collection: [1], next_href: 'https://elsewhere.example/users/3/likes?offset=x' }),
    })
    const client = testClient(api.fetch)
    await expect(client.collectAll({ path: 'users/1/likes', auth: 'none' })).resolves.toEqual([1, 2, 3])
    expect(api.requests[0].url.searchParams.get('linked_partitioning')).toBe('1')
    expect(api.requests[1].url.searchParams.get('client_id')).toBe(CLIENT_ID_A)
    await expect(client.collectAll({ path: 'users/2/likes', auth: 'none' })).rejects.toThrow(/did not advance/)
    await expect(client.collectAll({ path: 'users/3/likes', auth: 'none' })).rejects.toThrow(/outside its API/)
  })

  it('issues cursors without the client ID and accepts only its own', () => {
    const cursor = encodeCursor(`https://api-v2.soundcloud.com/mixed-selections?offset=10&client_id=${CLIENT_ID_A}`)!
    expect(Buffer.from(cursor, 'base64url').toString()).toBe('/mixed-selections?offset=10')
    expect(decodeCursor(cursor, 'mixed-selections')).toBe('https://api-v2.soundcloud.com/mixed-selections?offset=10')
    expect(() => decodeCursor(cursor, 'search/tracks')).toThrow()
    expect(() => decodeCursor(Buffer.from('https://evil.example/mixed-selections').toString('base64url'), 'mixed-selections')).toThrow()
  })
})
