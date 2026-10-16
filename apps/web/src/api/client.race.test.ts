// @vitest-environment jsdom
import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'

let server: Server | undefined
function stubJoinLocation(origin: string, navigation: ReturnType<typeof vi.fn>): void {
  const fakeLocation = { origin, href: `${origin}/join/rifling-911`, pathname: '/join/rifling-911', search: '', replace: navigation }
  const fakeWindow = Object.create(window) as Window
  Object.defineProperties(fakeWindow, {
    location: { value: fakeLocation },
    localStorage: { value: window.localStorage },
  })
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('location', fakeLocation)
}
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  window.localStorage.clear()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})

it.each(['/support', '/support/errors/guide?via=direct#step', '/support/unknown'])('retains an expired Support deep link while clearing and notifying the real session: %s', async path => {
  server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'support-expired' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  vi.stubEnv('VITE_API_BASE_URL', `http://127.0.0.1:${address.port}/api`)
  window.history.replaceState({}, '', path)
  window.localStorage.setItem('exwebsite.auth.token', 'current-token')
  const location = window.location
  const replace = vi.fn()
  // jsdom cannot navigate; expose navigation as an observable browser boundary.
  vi.stubGlobal('window', { localStorage: window.localStorage, location: {
    origin: location.origin, pathname: location.pathname, search: location.search, hash: location.hash, replace,
  } })
  vi.resetModules()
  const { api } = await import('@web/src/api/client')
  const { subscribeSessionChanges, readToken } = await import('@web/src/auth/storage')
  const observed: Array<string | null> = []
  const unsubscribe = subscribeSessionChanges(() => observed.push(readToken(window.localStorage)))
  try {
    await expect(api.GET('/auth/me', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(window.localStorage.getItem('exwebsite.auth.token')).toBeNull()
    expect(observed).toEqual([null])
    expect(replace).not.toHaveBeenCalled()
    expect(location.pathname + location.search + location.hash).toBe(path)
  } finally { unsubscribe() }
})

it('keeps the existing expiry redirect for similarly prefixed non-Support routes', async () => {
  server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'ordinary-expired' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  vi.stubEnv('VITE_API_BASE_URL', `http://127.0.0.1:${address.port}/api`)
  window.history.replaceState({}, '', '/support-other')
  window.localStorage.setItem('exwebsite.auth.token', 'current-token')
  const replace = vi.fn()
  vi.stubGlobal('window', { localStorage: window.localStorage, location: {
    origin: window.location.origin, pathname: '/support-other', search: '', replace,
  } })
  vi.resetModules()
  const { api } = await import('@web/src/api/client')
  await expect(api.GET('/auth/me', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  expect(replace).toHaveBeenCalledWith('/login')
})

it('keeps a newer cross-tab session when an old Web API request expires before its storage event', async () => {
  let arrived!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { arrived = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const authorization: string[] = []
  server = createServer(async (request, response) => {
    authorization.push(request.headers.authorization ?? '')
    response.setHeader('content-type', 'application/json')
    if (authorization.length === 1) {
      arrived()
      await gate
      response.statusCode = 401
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'old-request' } }))
    } else response.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  vi.stubEnv('VITE_API_BASE_URL', `http://127.0.0.1:${address.port}/api`)
  window.history.replaceState({}, '', '/login')
  window.localStorage.setItem('exwebsite.auth.token', 'old-token')
  vi.resetModules()
  const { api } = await import('@web/src/api/client')
  const pending = api.GET('/health', { alert: false })
  await reached
  window.localStorage.setItem('exwebsite.auth.token', 'new-token')
  release()
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  expect(window.localStorage.getItem('exwebsite.auth.token')).toBe('new-token')
  await expect(api.GET('/health', { alert: false })).resolves.toEqual({ status: 'ok' })
  expect(authorization).toEqual(['Bearer old-token', 'Bearer new-token'])
})

it('clears a matching persisted session and notifies the bound Web session', async () => {
  const authorization: string[] = []
  server = createServer((request, response) => {
    authorization.push(request.headers.authorization ?? '')
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'current-request' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  vi.stubEnv('VITE_API_BASE_URL', `http://127.0.0.1:${address.port}/api`)
  window.history.replaceState({}, '', '/login?ssoRequestId=keep-this-container')
  window.localStorage.setItem('exwebsite.auth.token', 'current-token')
  vi.resetModules()
  const { api } = await import('@web/src/api/client')
  const { subscribeSessionChanges, readToken } = await import('@web/src/auth/storage')
  const observed: Array<string | null> = []
  const unsubscribe = subscribeSessionChanges(() => observed.push(readToken(window.localStorage)))
  try {
    await expect(api.GET('/health', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(authorization).toEqual(['Bearer current-token'])
    expect(window.localStorage.getItem('exwebsite.auth.token')).toBeNull()
    expect(observed).toEqual([null])
    expect(window.location.pathname).toBe('/login')
    expect(window.location.search).toBe('?ssoRequestId=keep-this-container')
  } finally { unsubscribe() }
})

it.each([401, 503])('keeps the join page in place for replacement logout %s and restores normal expiry navigation', async logoutStatus => {
  const requests: string[] = []
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/auth/logout' || request.url === '/api/health') {
      response.statusCode = request.url === '/api/auth/logout' ? logoutStatus : 401
      response.end(JSON.stringify({ error: { code: logoutStatus === 503 && request.url === '/api/auth/logout' ? 'SERVICE_UNAVAILABLE' : 'SESSION_INVALID', message: 'expired', requestId: 'fixture' } }))
      return
    }
    response.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  const fixtureOrigin = `http://127.0.0.1:${address.port}`
  vi.stubEnv('VITE_API_BASE_URL', `${fixtureOrigin}/api`)
  window.localStorage.setItem('exwebsite.auth.token', 'old-token')
  const navigation = vi.fn()
  stubJoinLocation(fixtureOrigin, navigation)
  vi.resetModules()
  const { installBrowserSession } = await import('@web/src/auth/session-install')
  const { api } = await import('@web/src/api/client')
  const { subscribeSessionChanges } = await import('@web/src/auth/storage')
  const changes: Array<{ token: string | null; source: string; stored: string | null }> = []
  const unsubscribe = subscribeSessionChanges((token, source) => changes.push({ token, source, stored: window.localStorage.getItem('exwebsite.auth.token') }))
  const continuation = vi.fn()
  const result = await installBrowserSession('new-token', () => true)
  unsubscribe()
  if (result.status === 'installed') continuation()
  expect(result.status).toBe(logoutStatus === 401 ? 'installed' : 'failed')
  expect(continuation).toHaveBeenCalledTimes(logoutStatus === 401 ? 1 : 0)
  expect(window.localStorage.getItem('exwebsite.auth.token')).toBe(logoutStatus === 401 ? 'new-token' : 'old-token')
  expect(navigation).not.toHaveBeenCalled()
  expect(requests).toEqual(['POST /api/auth/logout Bearer old-token'])
  expect(changes).toEqual(logoutStatus === 401
    ? [{ token: null, source: 'http', stored: null }, { token: 'new-token', source: 'write', stored: 'new-token' }]
    : [])

  await expect(api.GET('/health', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  expect(navigation).toHaveBeenCalledWith('/login')
})

it('does not suppress a concurrent protected expiry while replacement logout is pending', async () => {
  let reached!: () => void, release!: () => void
  const logoutReached = new Promise<void>(resolve => { reached = resolve })
  const logoutGate = new Promise<void>(resolve => { release = resolve })
  server = createServer(async (request, response) => {
    if (request.url === '/api/auth/logout') { reached(); await logoutGate }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'fixture' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  const fixtureOrigin = `http://127.0.0.1:${address.port}`
  vi.stubEnv('VITE_API_BASE_URL', `${fixtureOrigin}/api`)
  window.localStorage.setItem('exwebsite.auth.token', 'old-token')
  const navigation = vi.fn()
  stubJoinLocation(fixtureOrigin, navigation)
  vi.resetModules()
  const { installBrowserSession } = await import('@web/src/auth/session-install')
  const { api } = await import('@web/src/api/client')
  const installing = installBrowserSession('new-token', () => true)
  await logoutReached
  await expect(api.GET('/health', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  expect(navigation).toHaveBeenCalledWith('/login')
  release()
  await installing
})

it('releases replacement handling after a cancelled sign-in', async () => {
  let reached!: () => void, release!: () => void
  const logoutReached = new Promise<void>(resolve => { reached = resolve })
  const logoutGate = new Promise<void>(resolve => { release = resolve })
  server = createServer(async (request, response) => {
    if (request.url === '/api/auth/logout') { reached(); await logoutGate }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'fixture' } }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected fixture TCP address')
  const fixtureOrigin = `http://127.0.0.1:${address.port}`
  vi.stubEnv('VITE_API_BASE_URL', `${fixtureOrigin}/api`)
  window.localStorage.setItem('exwebsite.auth.token', 'old-token')
  const navigation = vi.fn()
  stubJoinLocation(fixtureOrigin, navigation)
  vi.resetModules()
  const { installBrowserSession } = await import('@web/src/auth/session-install')
  const { api } = await import('@web/src/api/client')
  const { writeToken } = await import('@web/src/auth/storage')
  let current = true
  const installing = installBrowserSession('new-token', () => current)
  await logoutReached
  current = false
  release()
  expect(await installing).toEqual({ status: 'stale' })
  expect(navigation).not.toHaveBeenCalled()
  expect(window.localStorage.getItem('exwebsite.auth.token')).toBeNull()
  writeToken(window.localStorage, 'other-token')
  await expect(api.GET('/health', { alert: false })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  expect(navigation).toHaveBeenCalledWith('/login')
})
