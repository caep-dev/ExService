import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExAxios, ExAxiosError } from '@sdk/src/http/node'
import { createHttpCore } from '@sdk/src/http/core'
import { createApiClient } from '@api-client/src/client'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })

async function fixture(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

describe('ExAxios Node HTTP boundary', () => {
  it('uses same-origin browser cookies only when explicitly enabled and keeps redirects blocked for protected requests', async () => {
    const origin='http://127.0.0.1:18080',requests:Request[]=[]
    const intercept=vi.spyOn(globalThis,'fetch').mockImplementation(async request=>{
      requests.push(request as Request)
      return new Response('{}',{headers:{'content-type':'application/json'}})
    })
    try {
      const http=createHttpCore({environment:'browser',origin},{baseUrl:`${origin}/api`,websiteBaseUrl:`${origin}/api`,sameOriginCookies:true,alert:false})
      http.setToken('token')
      await http({url:'/auth/registration/code',method:'POST',data:{email:'member@example.com'}})
      await http({url:'http://127.0.0.1:18081/api/public'})
      const isolated=createHttpCore({environment:'browser',origin},{alert:false})
      await isolated({url:'/public'})
      expect(requests.map(request=>request.credentials)).toEqual(['same-origin','same-origin','omit'])
      expect(requests[0]!.redirect).toBe('error')
      expect(requests[1]!.headers.has('Authorization')).toBe(false)
    } finally {intercept.mockRestore()}
  })
  it('returns JSON body and attaches a scoped token', async () => {
    const received: string[] = []
    const origin = await fixture((request, response) => {
      received.push(request.headers.authorization ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ status: 'ok' }))
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api` })
    http.setToken('secret')
    expect(await http<{ status: string }>({ url: '/health' })).toEqual({ status: 'ok' })
    expect(received).toEqual(['Bearer secret'])
  })

  it('does not follow an authenticated redirect outside the API scope', async () => {
    const received: string[] = []
    const destination = await fixture((request, response) => { received.push(request.headers.authorization ?? ''); response.end('reached') })
    const origin = await fixture((_request, response) => { response.writeHead(302, { location: `${destination}/receive` }); response.end() })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    http.setToken('secret')
    await expect(http({ url: '/redirect' })).rejects.toBeInstanceOf(ExAxiosError)
    expect(received).toEqual([])
  })

  it.each([302, 307])('does not forward an explicit website Authorization through a %i redirect', async status => {
    const received: string[] = []
    const destination = await fixture((request, response) => { received.push(request.headers.authorization ?? ''); response.end('reached') })
    const origin = await fixture((_request, response) => { response.writeHead(status, { location: `${destination}/receive` }); response.end() })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    await expect(http({ url: '/redirect', headers: { Authorization: 'Bearer storage-token' } })).rejects.toMatchObject({ kind: 'http', status })
    expect(received).toEqual([])
  })

  it.each([302, 307])('blocks %i redirects to same-origin /docs and another origin for both authentication sources', async status => {
    const local: string[] = [], remote: string[] = []
    const destination = await fixture((request, response) => { remote.push(request.headers.authorization ?? ''); response.end('reached') })
    const origin = await fixture((request, response) => {
      if (request.url === '/docs') { local.push(request.headers.authorization ?? ''); response.end('reached'); return }
      response.writeHead(status, { location: request.url === '/api/to-docs' ? '/docs' : `${destination}/receive` })
      response.end()
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    for (const mode of ['explicit', 'automatic'] as const) {
      if (mode === 'automatic') http.setToken('internal-token')
      for (const url of ['/to-docs', '/to-remote']) {
        const headers = mode === 'explicit' ? { Authorization: 'Bearer storage-token' } : undefined
        await expect(http({ url, headers })).rejects.toMatchObject({ kind: 'http', status })
      }
    }
    expect(local).toEqual([])
    expect(remote).toEqual([])
  })

  it('distinguishes API scope from its prefix neighbor and preserves setters after invalid input', async () => {
    const received: Array<{ url: string; auth?: string }> = []
    const origin = await fixture((request, response) => {
      received.push({ url: request.url ?? '', auth: request.headers.authorization })
      response.setHeader('content-type', 'application/json'); response.end('{}')
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    http.setToken('secret')
    expect(() => http.setBaseUrl('https://user:secret@example.test/api', { website: true })).toThrow(ExAxiosError)
    expect(() => http.setToken('bad\r\ntoken')).toThrow(ExAxiosError)
    await http({ url: '/ok' })
    await http({ url: `${origin}/api-other` })
    expect(received).toEqual([{ url: '/api/ok', auth: 'Bearer secret' }, { url: '/api-other', auth: undefined }])
  })

  it('rejects unknown runtime options and unsafe URL forms before any request', async () => {
    const received: string[] = []
    const origin = await fixture((request, response) => {
      received.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
    })
    const missing = createExAxios({ alert: false })
    await expect(missing({ url: '/health' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    for (const config of [
      { url: '/unsafe', adapter: 'fetch' }, { url: '/unsafe', socketPath: '/tmp/socket' },
      { url: '/unsafe', headers: { Host: 'evil.test' } }, { url: '/unsafe', timeout: -1 },
      { url: '/%2Fescape' }, { url: '/..\\docs' },
    ]) await expect(http(config as Parameters<typeof http>[0])).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect(() => http.setBaseUrl('ftp://example.test/api', { website: true })).toThrow(ExAxiosError)
    expect(() => http.setBaseUrl(`${origin}/changed`, { website: 'yes' } as never)).toThrow(ExAxiosError)
    expect(() => http.setAlert('yes' as never)).toThrow(ExAxiosError)
    await http({ url: '/ok' })
    expect(received).toEqual(['/api/ok'])
  })

  it('encodes query parameters, accepts absolute overrides, and excludes other ports', async () => {
    const received: Array<{ url: string; auth?: string }> = []
    const origin = await fixture((request, response) => {
      received.push({ url: request.url ?? '', auth: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
    })
    const other = await fixture((request, response) => {
      received.push({ url: request.url ?? '', auth: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    http.setToken('secret')
    await http({ url: '/sp ace', params: { tag: ['a b', 'c'], omitted: undefined } })
    await http({ url: `${other}/api/health` })
    expect(received).toEqual([
      { url: '/api/sp%20ace?tag=a+b&tag=c', auth: 'Bearer secret' },
      { url: '/api/health', auth: undefined },
    ])
  })

  it('lets the typed storage download carry an encoded slash in its query key over real HTTP', async () => {
    const received: string[] = []
    const origin = await fixture((request, response) => {
      received.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from([3, 4, 5]))
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    const client = createApiClient({ baseUrl: `${origin}/api`, transport: request => http(request) })
    const body = await client.GET('/storage/files', { params: { query: { key: 'demo/file.bin' } }, responseType: 'arraybuffer' })
    expect([...new Uint8Array(body)]).toEqual([3, 4, 5])
    expect(received).toEqual(['/api/storage/files?key=demo%2Ffile.bin'])
    await expect(http({ url: '/storage%2Ffiles' })).rejects.toMatchObject({ code: 'CONFIG_ERROR' })
  })

  it('classifies the actual Axios fetch adapter deadline as TIMEOUT', async () => {
    const origin = await fixture((_request, _response) => {})
    const http = createHttpCore({ environment: 'browser', origin }, { baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    await expect(http({ url: '/slow', timeout: 20 })).rejects.toMatchObject({ kind: 'timeout', code: 'TIMEOUT' })
  })

  it('does not clear the local session for an unrelated explicit Authorization', async () => {
    const auth: string[] = []
    const origin = await fixture((request, response) => {
      auth.push(request.headers.authorization ?? '')
      if (request.url === '/api/ok') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'r' } }))
    })
    let expired = 0
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false, onSessionExpired: () => { expired++ } })
    http.setToken('internal')
    await expect(http({ url: '/expired', headers: { Authorization: 'Bearer other' } })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    await http({ url: '/ok' })
    expect(expired).toBe(0)
    expect(auth).toEqual(['Bearer other', 'Bearer internal'])
  })

  it('classifies a JSON error and ignores a forged incoming request ID', async () => {
    const origin = await fixture((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'header-id', 'retry-after': '2' })
      response.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: '请稍后重试', requestId: 'body-id' } }))
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    await expect(http({ url: '/wait' })).rejects.toMatchObject({ kind: 'http', code: 'RATE_LIMITED', status: 429, requestId: 'body-id', retryAfterSeconds: 2 })
  })

  it('handles one concurrent invalid session once and allows a newly supplied token', async () => {
    let count = 0
    const auth: string[] = []
    const origin = await fixture((request, response) => {
      auth.push(request.headers.authorization ?? '')
      if (request.url === '/api/ok') { response.setHeader('content-type', 'application/json'); response.end('{}'); return }
      response.setHeader('content-type', 'application/json')
      response.statusCode = 401
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: '登录状态已失效', requestId: 'req-1' } }))
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false, onSessionExpired: () => { count++ } })
    http.setToken('old')
    const results = await Promise.allSettled([http({ url: '/expired' }), http({ url: '/expired' })])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(count).toBe(1)
    http.setToken('new')
    await http({ url: '/ok' })
    expect(auth).toEqual(['Bearer old', 'Bearer old', 'Bearer new'])
  })

  it('ignores a late invalid session from an older token revision', async () => {
    let release!: () => void, arrived!: () => void
    const reached = new Promise<void>(resolve => { arrived = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const auth: string[] = []
    const origin = await fixture(async (request, response) => {
      auth.push(request.headers.authorization ?? '')
      if (request.url === '/api/slow') {
        arrived(); await gate
        response.statusCode = 401
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: '登录状态已失效', requestId: 'req-2' } }))
      } else { response.setHeader('content-type', 'application/json'); response.end('{}') }
    })
    let expired = 0
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false, onSessionExpired: () => { expired++ } })
    http.setToken('old')
    const pending = http({ url: '/slow' })
    await reached
    http.setToken('new')
    release()
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    await http({ url: '/ok' })
    expect(expired).toBe(0)
    expect(auth).toEqual(['Bearer old', 'Bearer new'])
  })

  it('ignores a late 401 from an older website scope and can expire a newly set token', async () => {
    let release!: () => void, arrived!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { arrived = resolve })
    const oldOrigin = await fixture(async (_request, response) => {
      arrived(); await gate
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'old' } }))
    })
    const newAuth: string[] = []
    const newOrigin = await fixture((request, response) => {
      newAuth.push(request.headers.authorization ?? '')
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'new' } }))
    })
    let expired = 0
    const http = createExAxios({ baseUrl: `${oldOrigin}/api`, websiteBaseUrl: `${oldOrigin}/api`, alert: false, onSessionExpired: () => { expired++ } })
    http.setToken('old-token')
    const pending = http({ url: '/slow' })
    await reached
    http.setBaseUrl(`${newOrigin}/api`, { website: true })
    http.setToken('new-token')
    release()
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(expired).toBe(0)
    await expect(http({ url: '/expire' })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(expired).toBe(1)
    http.setToken('another-token')
    await expect(http({ url: '/expire' })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(expired).toBe(2)
    expect(newAuth).toEqual(['Bearer new-token', 'Bearer another-token'])
  })

  it('does not clear or navigate when a bound browser session becomes unreadable', async () => {
    let reads = 0, clears = 0, notifications = 0, navigations = 0
    const authorization: string[] = []
    const origin = await fixture((request, response) => {
      authorization.push(request.headers.authorization ?? '')
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'unreadable' } }))
    })
    const http = createHttpCore({
      environment: 'browser', origin,
      readToken: () => { if (++reads === 1) return 'old-token'; throw new Error('storage unavailable') },
      clearToken: () => { clears++; return true },
      notify: () => { notifications++ },
      navigate: () => { navigations++ },
    }, { baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api` })
    await expect(http({ url: '/expired' })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(authorization).toEqual(['Bearer old-token'])
    expect(clears).toBe(0)
    expect(notifications).toBe(0)
    expect(navigations).toBe(0)
  })

  it('does not replace an explicit in-memory token with an unrelated persisted token', async () => {
    const authorization: string[] = []
    const origin = await fixture((request, response) => {
      authorization.push(request.headers.authorization ?? '')
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'manual' } }))
    })
    let stored = 'persisted-token', clears = 0
    const http = createHttpCore({
      environment: 'browser', origin,
      readToken: () => stored,
      clearToken: () => { clears++; stored = ''; return true },
    }, { baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    http.setToken('manual-token')
    await expect(http({ url: '/expired' })).rejects.toMatchObject({ code: 'SESSION_INVALID' })
    expect(authorization).toEqual(['Bearer manual-token'])
    expect(stored).toBe('persisted-token')
    expect(clears).toBe(0)
  })

  it('keeps network, cancellation, and timeout errors free of request details', async () => {
    const origin = await fixture((_request, _response) => {})
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(http({ url: '/cancel', signal: cancelled.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(http({ url: '/timeout', timeout: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('snapshots alert choice at send time and leaves callback errors behind', async () => {
    const messages: string[] = []
    const origin = await fixture((_request, response) => {
      response.statusCode = 503; response.end('not-json')
    })
    const http = createHttpCore({ environment: 'node', notify: message => messages.push(message) }, { baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    await expect(http({ url: '/silent' })).rejects.toBeInstanceOf(ExAxiosError)
    await expect(http({ url: '/loud', alert: true })).rejects.toMatchObject({ code: 'HTTP_ERROR' })
    expect(messages).toEqual(['请求失败，请稍后重试'])
  })

  it('rejects invalid success JSON and parses small binary errors and HTTP-date Retry-After', async () => {
    const retryDate = new Date(Date.now() + 30_000).toUTCString()
    const origin = await fixture((request, response) => {
      if (request.url === '/api/invalid') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{invalid'); return }
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': retryDate })
      response.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'try later', requestId: 'binary-id' } }))
    })
    const http = createExAxios({ baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, alert: false })
    await expect(http({ url: '/invalid' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 200 })
    const error = await http({ url: '/binary', responseType: 'arraybuffer' }).then(() => { throw new Error('expected HTTP failure') }, value => value as ExAxiosError)
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, requestId: 'binary-id' })
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(28)
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(30)
  })

  it('preserves the HTTP error when notification and session callbacks throw', async () => {
    const origin = await fixture((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'expired', requestId: 'safe-id' } }))
    })
    const http = createHttpCore({ environment: 'node', notify: () => { throw new Error('notify failed') } }, {
      baseUrl: `${origin}/api`, websiteBaseUrl: `${origin}/api`, onSessionExpired: () => { throw new Error('callback failed') },
    })
    http.setToken('secret')
    await expect(http({ url: '/expired' })).rejects.toMatchObject({ code: 'SESSION_INVALID', requestId: 'safe-id' })
  })
})
