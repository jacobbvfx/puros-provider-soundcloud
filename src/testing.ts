import { SoundCloudClient, type ClientIdStore } from './api'

export const CLIENT_ID_A = 'a'.repeat(32)
export const CLIENT_ID_B = 'B'.repeat(32)

export interface Recorded {
  url: URL
  authorization: string | null
}

type Route = (url: URL, request: Recorded) => Response | Promise<Response>

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * soundcloud.com (one asset script embedding the current client ID) plus
 * api-v2 routes keyed by path. Unknown paths answer 404.
 */
export function fakeSoundCloud(routes: Record<string, Route>, options: { clientIds?: string[] } = {}) {
  const clientIds = [...(options.clientIds ?? [CLIENT_ID_A])]
  const requests: Recorded[] = []
  let scrapes = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init?.headers)
    if (url.href === 'https://soundcloud.com/') {
      return new Response('<html><script crossorigin src="https://a-v2.sndcdn.com/assets/0-aaaa.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/49-bbbb.js"></script></html>')
    }
    if (url.hostname === 'a-v2.sndcdn.com') {
      if (url.pathname.endsWith('49-bbbb.js')) {
        scrapes += 1
        return new Response(`({client_id:"${clientIds[Math.min(scrapes - 1, clientIds.length - 1)]}",env:"production"})`)
      }
      return new Response('/* no id here */')
    }
    const recorded = { url, authorization: headers.get('authorization') }
    requests.push(recorded)
    const route = routes[url.pathname.replace(/^\//, '')] ?? routes[url.href.split('?')[0]]
    if (!route) return json({ error: 'not found' }, 404)
    return route(url, recorded)
  }) as typeof fetch
  return { fetch: fetchImpl, requests, scrapes: () => scrapes }
}

export function memoryClientIds(initial: string | null = null): ClientIdStore & { value: string | null } {
  const store = {
    value: initial,
    async load() { return store.value },
    async save(clientId: string | null) { store.value = clientId },
  }
  return store
}

export function testClient(fetchImpl: typeof fetch, options: { token?: () => string | null; onSessionRejected?: () => void; now?: () => number } = {}) {
  return new SoundCloudClient({
    fetch: fetchImpl,
    getToken: options.token ?? (() => null),
    onSessionRejected: options.onSessionRejected,
    clientIds: memoryClientIds(),
    sleep: async () => {},
    now: options.now,
  })
}
