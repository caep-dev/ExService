import { afterEach, expect, it, vi } from 'vitest'
import { constants, createPublicKey, generateKeyPairSync, publicEncrypt } from 'node:crypto'

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const services: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.useRealTimers() })

async function fixture(options: Record<string, unknown> = {}) {
  const module = await import('@server/src/modules/cfx/service').catch(() => undefined)
  expect(module, 'Cfx service must exist').toBeDefined()
  let time = 0, wall = 1_800_000_000_000
  const requests: Array<{ url: string; headers: Headers }> = []
  const service = module!.createCfxServices({
    config: { enabled: true, mode: 'manual', publicOrigin: 'http://127.0.0.1:8080', applicationName: 'ExWebsite' },
    now: () => time, wallNow: () => wall,
    generateKeys: async () => keyPair,
    fetch: async (url: string | URL, init: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init.headers) })
      return Response.json(String(url).includes('/session/')
        ? { current_user: { id: 8914174, username: 'Dogleg', avatar_template: '/avatar/{size}.png', secret: 'ignored' } }
        : { email: ' USER@EXAMPLE.COM ', associated_accounts: [] })
    },
    ...options,
  })
  services.push(service)
  const create = (clientIp = '127.0.0.1', bindingToken?: string, signal?: AbortSignal) => service.begin({ clientIp, bindingToken, signal })
  const first = await create()
  const context = service.resolveBrowserContext({ bindingToken: first.cookieValue, clientIp: '127.0.0.1' })
  const payload = (changes: Record<string, unknown> = {}, source = first) => {
    const url = new URL(source.response.authorizationUrl)
    return publicEncrypt({ key: createPublicKey(url.searchParams.get('public_key')!), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(JSON.stringify({ key: 'TEST_USER_API_KEY', nonce: url.searchParams.get('nonce'), api: 4, push: false, ...changes }))).toString('base64')
  }
  const complete = (encrypted = payload(), signal?: AbortSignal) => service.complete({ context, attemptId: first.response.attemptId, payload: encrypted, source: 'manual', signal })
  return { service, first, context, create, payload, complete, requests, advance(ms: number) { time += ms; wall += ms }, rewindWall(ms: number) { wall -= ms } }
}

it('verifies real OAEP and delivers four fields plus a browser-bound ticket consumed once', async () => {
  const f = await fixture()
  const url = new URL(f.first.response.authorizationUrl)
  expect(url.searchParams.get('padding')).toBe('oaep')
  expect(url.searchParams.get('scopes')).toBe('session_info,read')
  expect(url.searchParams.has('auth_redirect')).toBe(false)
  await f.complete(`\n ${f.payload()} \r\n`)
  const ready = f.service.inspect(f.context, f.first.response.attemptId)
  expect(ready.state).toBe('ready')
  if (ready.state !== 'ready') throw new Error('expected ready')
  expect(ready.identity).toEqual({ id: '8914174', username: 'Dogleg', avatarUrl: 'https://forum.cfx.re/avatar/512.png', email: 'user@example.com' })
  expect(f.requests.map(request => request.url)).toEqual(['https://forum.cfx.re/session/current.json', 'https://forum.cfx.re/u/Dogleg/emails.json'])
  for (const request of f.requests) {
    expect(request.headers.get('User-Api-Key')).toBe('TEST_USER_API_KEY')
    expect(request.headers.get('User-Api-Client-Id')).toBe(url.searchParams.get('client_id'))
  }
  ready.identity.email = 'mutated@example.com'
  const outcomes = await Promise.allSettled([1, 2].map(async () => f.service.consumeIdentity({ context: f.context, identityTicket: ready.identityTicket })))
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find(outcome => outcome.status === 'fulfilled')).toMatchObject({ value: { email: 'user@example.com' } })
  expect(f.service.inspect(f.context, ready.attemptId)).not.toHaveProperty('identity')
})

it('rejects tickets from another attempt in the same browser without consuming either proof', async () => {
  const f = await fixture()
  const second = await f.create('127.0.0.1', f.first.cookieValue)
  await f.complete()
  await f.service.complete({ context: f.context, attemptId: second.response.attemptId,
    payload: f.payload({}, second), source: 'manual' })
  const firstReady = f.service.inspect(f.context, f.first.response.attemptId)
  const secondReady = f.service.inspect(f.context, second.response.attemptId)
  if (firstReady.state !== 'ready' || secondReady.state !== 'ready') throw new Error('expected both ready')

  expect(() => f.service.consumeIdentity({ context: f.context, identityTicket: secondReady.identityTicket,
    expectedAttemptId: firstReady.attemptId })).toThrow(expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_INVALID' }))
  expect(() => f.service.consumeIdentity({ context: f.context, identityTicket: firstReady.identityTicket,
    expectedAttemptId: secondReady.attemptId })).toThrow(expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_INVALID' }))
  expect(f.service.inspect(f.context, firstReady.attemptId).state).toBe('ready')
  expect(f.service.inspect(f.context, secondReady.attemptId).state).toBe('ready')

  expect(f.service.consumeIdentity({ context: f.context, identityTicket: firstReady.identityTicket,
    expectedAttemptId: firstReady.attemptId })).toEqual({ id: '8914174', username: 'Dogleg',
    avatarUrl: 'https://forum.cfx.re/avatar/512.png', email: 'user@example.com' })
  expect(() => f.service.consumeIdentity({ context: f.context, identityTicket: firstReady.identityTicket,
    expectedAttemptId: firstReady.attemptId })).toThrow(expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_INVALID' }))
  expect(f.service.consumeIdentity({ context: f.context, identityTicket: secondReady.identityTicket,
    expectedAttemptId: secondReady.attemptId })).toHaveProperty('id', '8914174')
})

it.each([
  [{ nonce: '0'.repeat(32) }, 'CFX_NONCE_INVALID'],
  [{ api: 3 }, 'CFX_API_VERSION_UNSUPPORTED'],
  [{ key: '' }, 'CFX_INVALID_PAYLOAD'],
  [{ push: 'false' }, 'CFX_INVALID_PAYLOAD'],
])('ends claimed attempts on invalid authorization %j', async (changes, code) => {
  const f = await fixture()
  await expect(f.complete(f.payload(changes))).rejects.toMatchObject({ code })
  expect(f.service.inspect(f.context, f.first.response.attemptId)).toMatchObject({ state: 'failed', failureCode: code })
  expect(f.requests).toHaveLength(0)
  await expect(f.complete()).rejects.toMatchObject({ code: 'CFX_ATTEMPT_CONFLICT' })
})

it('rejects malformed shapes before claiming and denies another browser without state changes', async () => {
  const f = await fixture()
  await expect(f.complete('not base64')).rejects.toMatchObject({ code: 'CFX_INVALID_PAYLOAD' })
  expect(f.service.inspect(f.context, f.first.response.attemptId).state).toBe('pending')
  const other = await f.create('127.0.0.2')
  const context = f.service.resolveBrowserContext({ bindingToken: other.cookieValue, clientIp: '127.0.0.2' })
  expect(() => f.service.cancel(context, f.first.response.attemptId)).toThrow(expect.objectContaining({ code: 'CFX_ATTEMPT_NOT_FOUND' }))
  await f.complete()
  const ready = f.service.inspect(f.context, f.first.response.attemptId)
  if (ready.state !== 'ready') throw new Error('expected ready')
  expect(() => f.service.consumeIdentity({ context, identityTicket: ready.identityTicket })).toThrow(expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_INVALID' }))
  expect(f.service.inspect(f.context, ready.attemptId).state).toBe('ready')
})

it('expires at the exact monotonic deadline without sweep or wall-clock renewal', async () => {
  const f = await fixture()
  await f.complete()
  const ready = f.service.inspect(f.context, f.first.response.attemptId)
  if (ready.state !== 'ready') throw new Error('expected ready')
  f.rewindWall(999999)
  f.advance(300000)
  expect(() => f.service.consumeIdentity({ context: f.context, identityTicket: ready.identityTicket })).toThrow(expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_EXPIRED' }))
  expect(f.service.inspect(f.context, ready.attemptId)).toMatchObject({ state: 'expired' })
  f.advance(300000)
  expect(() => f.service.inspect(f.context, ready.attemptId)).toThrow(expect.objectContaining({ code: 'CFX_ATTEMPT_NOT_FOUND' }))
})

it('allows one completion task and cancellation prevents late readiness', async () => {
  let release!: (value: Response) => void
  const f = await fixture({ fetch: () => new Promise<Response>(resolve => { release = resolve }) })
  const pending = f.complete()
  await expect(f.complete()).rejects.toMatchObject({ code: 'CFX_ATTEMPT_CONFLICT' })
  expect(f.service.cancel(f.context, f.first.response.attemptId).state).toBe('cancelled')
  release(Response.json({ current_user: { id: 1, username: 'Other', avatar_template: '/{size}.png' } }))
  await expect(pending).rejects.toMatchObject({ code: 'CFX_ATTEMPT_CONFLICT' })
  expect(f.service.inspect(f.context, f.first.response.attemptId)).not.toHaveProperty('identity')
})

it('keeps generation slots until actual settlement and close waits for work', async () => {
  const f = await fixture()
  let releases: Array<(value: typeof keyPair) => void> = []
  const module = await import('@server/src/modules/cfx/service')
  const service = module.createCfxServices({ config: f.service.config,
    generateKeys: () => new Promise(resolve => { releases.push(resolve) }) })
  services.push(service)
  const abort = new AbortController()
  const first = service.begin({ clientIp: '1', signal: abort.signal })
  const second = service.begin({ clientIp: '2' })
  abort.abort()
  await expect(service.begin({ clientIp: '3' })).rejects.toMatchObject({ code: 'CFX_CAPACITY_EXCEEDED' })
  let closed = false
  const closing = service.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  releases.forEach(release => release(keyPair)); releases = []
  await expect(first).rejects.toMatchObject({ code: 'CFX_SERVICE_CLOSED' })
  await expect(second).rejects.toMatchObject({ code: 'CFX_SERVICE_CLOSED' })
  await closing
  expect(() => service.start()).not.toThrow()
  await expect(service.begin({ clientIp: '4' })).rejects.toMatchObject({ code: 'CFX_SERVICE_CLOSED' })
})

it('enforces per-browser active capacity and fixed request windows', async () => {
  const f = await fixture()
  await f.create('127.0.0.1', f.first.cookieValue)
  await f.create('127.0.0.1', f.first.cookieValue)
  await expect(f.create('127.0.0.1', f.first.cookieValue)).rejects.toMatchObject({ code: 'CFX_CAPACITY_EXCEEDED' })
  for (let i = 0; i < 60; i++) f.service.inspect(f.context, f.first.response.attemptId)
  expect(() => f.service.inspect(f.context, f.first.response.attemptId)).toThrow(expect.objectContaining({ code: 'CFX_REQUEST_LIMITED', retryAfterSeconds: 60 }))
  f.advance(60000)
  expect(f.service.inspect(f.context, f.first.response.attemptId).state).toBe('pending')
})

it('turns request and total timeouts into failed rather than leaving processing records', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await fixture({ fetch: () => new Promise(() => {}) })
  const completing = f.complete().catch(error => error)
  f.advance(20000)
  await vi.advanceTimersByTimeAsync(20000)
  expect(await completing).toMatchObject({ code: 'CFX_UPSTREAM_TIMEOUT' })
  expect(f.service.inspect(f.context, f.first.response.attemptId)).toMatchObject({ state: 'failed', failureCode: 'CFX_UPSTREAM_TIMEOUT' })
})

it('fails total deadline across two requests and expires when authorization deadline wins', async () => {
  let f = await fixture({ fetch: async () => { f.advance(21000); return Response.json({ current_user: { id: 1, username: 'X', avatar_template: '/{size}' }, email: 'x@example.com' }) } })
  await expect(f.complete()).rejects.toMatchObject({ code: 'CFX_UPSTREAM_TIMEOUT' })
  expect(f.service.inspect(f.context, f.first.response.attemptId).state).toBe('failed')
  f = await fixture({ fetch: async () => { f.advance(1000); return Response.json({ current_user: { id: 1, username: 'X', avatar_template: '/{size}' }, email: 'x@example.com' }) } })
  f.advance(599000)
  await expect(f.complete()).rejects.toMatchObject({ code: 'CFX_ATTEMPT_EXPIRED' })
  expect(f.service.inspect(f.context, f.first.response.attemptId).state).toBe('expired')
})

it('closing processing work aborts and discards a late response', async () => {
  let signal!: AbortSignal, release!: (response: Response) => void
  const f = await fixture({ fetch: (_url: string, init: RequestInit) => { signal = init.signal!; return new Promise<Response>(resolve => { release = resolve }) } })
  const task = f.complete()
  const settled = task.catch(error => error)
  await f.service.close()
  expect(signal.aborted).toBe(true)
  release(Response.json({ current_user: { id: 1, username: 'X', avatar_template: '/{size}' } }))
  expect(await settled).toMatchObject({ code: 'CFX_SERVICE_CLOSED' })
})

it('never overwrites attempts or tickets on random collision', async () => {
  let token = 'A'.repeat(43)
  const f = await fixture({ randomToken: () => token })
  // Binding and attempt IDs have separate indexes, while attempt IDs cannot overwrite.
  await expect(f.create('other', f.first.cookieValue)).rejects.toThrow('Cfx identifier generation failed.')
  expect(f.service.inspect(f.context, f.first.response.attemptId).state).toBe('pending')
  token = 'B'.repeat(43)
  await f.complete()
  const next = await f.create('other', f.first.cookieValue)
  await expect(f.service.complete({ context: f.context, attemptId: next.response.attemptId, payload: f.payload({}, next), source: 'manual' })).rejects.toThrow('Cfx identifier generation failed.')
  const original = f.service.inspect(f.context, f.first.response.attemptId)
  expect(original.state).toBe('ready')
})

it('bounds all attempts including terminal records and recovers only after their retention', async () => {
  const f = await fixture()
  f.service.cancel(f.context, f.first.response.attemptId)
  for (let i = 1; i < 256; i++) {
    const created = await f.create(`ip-${i}`)
    const context = f.service.resolveBrowserContext({ bindingToken: created.cookieValue, clientIp: `ip-${i}` })
    f.service.cancel(context, created.response.attemptId)
  }
  await expect(f.create('overflow')).rejects.toMatchObject({ code: 'CFX_CAPACITY_EXCEEDED' })
  f.advance(300000)
  await expect(f.create('recovered')).resolves.toHaveProperty('response.attemptId')
})
