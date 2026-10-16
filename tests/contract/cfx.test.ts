import { afterEach, expect, it } from 'vitest'
import { createApp, serviceHandlers } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import { createCfxServices, type CfxDependencies } from '@server/src/modules/cfx/service'
import { parseCfxConfig } from '@server/src/modules/cfx/config'
import { IdentityLinkService } from '@server/src/modules/identity-links/service'
import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import { Writable } from 'node:stream'
import { compileComponentSchema, listOperations, readContract } from '@tests/helpers/contract'

const fixtures: TestAuth[] = []
const apps: ReturnType<typeof createApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

async function enabled(production = false, logger: Parameters<typeof createApp>[0]['logger'] = false, dependencies: Partial<Omit<CfxDependencies, 'config'>> = {}) {
  const fixture = await createTestAuth(); fixtures.push(fixture)
  const cfxServices = createCfxServices({ config: parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: production ? 'production' : 'development',
    SERVER_PUBLIC_WEB_BASE_URL: production ? 'https://website.example' : 'http://127.0.0.1:8080' }),
    fetch: async url => Response.json(url.includes('/session/') ? { current_user: { id: 1, username: 'Member', avatar_template: '/avatar/{size}.png' } } : { email: 'private@example.com' }), ...dependencies })
  const identityLinkServices = new IdentityLinkService({ db: fixture.db, auth: fixture.authServices, cfx: cfxServices, now: fixture.now })
  const app = createApp({ ...fixture, cfxServices, identityLinkServices, logger }); apps.push(app)
  const origin = production ? 'https://website.example' : 'http://127.0.0.1:8080'
  const created = await app.inject({ method: 'POST', url: '/api/auth/cfx/attempts', headers: { origin }, payload: {} })
  expect(created.statusCode).toBe(201)
  const cookie = String(created.headers['set-cookie']).split(';')[0]!
  const result = created.json()
  const authorization = new URL(result.authorizationUrl)
  const payload = publicEncrypt({ key: createPublicKey(authorization.searchParams.get('public_key')!), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(JSON.stringify({ key: 'PRIVATE_CFX_KEY', nonce: authorization.searchParams.get('nonce'), api: 4, push: false }))).toString('base64')
  return { app, cfxServices, created, cookie, origin, result, authorization, payload }
}

it('runs manual HTTP completion and rejects unsafe browser requests before consuming state', async () => {
  const f = await enabled()
  expect(String(f.created.headers['set-cookie'])).toContain('HttpOnly')
  expect(String(f.created.headers['set-cookie'])).toContain('SameSite=Lax')
  const url = `/api/auth/cfx/attempts/${f.result.attemptId}`
  for (const headers of [{ cookie: f.cookie }, { cookie: f.cookie, origin: 'null' }, { cookie: f.cookie, origin: 'https://evil.example' }]) {
    expect((await f.app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(403)
  }
  expect((await f.app.inject({ method: 'GET', url, headers: { cookie: f.cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403)
  expect((await f.app.inject({ method: 'GET', url })).statusCode).toBe(404)
  expect((await f.app.inject({ method: 'GET', url, headers: { cookie: `${f.cookie}; ${f.cookie}` } })).statusCode).toBe(400)
  expect((await f.app.inject({ method: 'GET', url: `${url}?x=1`, headers: { cookie: f.cookie } })).statusCode).toBe(400)
  const oversized = await f.app.inject({ method: 'POST', url: `${url}/complete`, headers: { cookie: f.cookie, origin: f.origin }, payload: { payload: ' '.repeat(5000) } })
  expect(oversized.statusCode).toBe(413)
  const done = await f.app.inject({ method: 'POST', url: `${url}/complete`, headers: { cookie: f.cookie, origin: f.origin }, payload: { payload: f.payload } })
  expect(done.statusCode).toBe(200)
  expect(compileComponentSchema('CfxCompletion')(done.json())).toBe(true)
  const ready = await f.app.inject({ method: 'GET', url, headers: { cookie: f.cookie } })
  expect(compileComponentSchema('CfxAttemptStatus')(ready.json())).toBe(true)
  expect(ready.json()).toMatchObject({ state: 'ready', identity: { email: 'private@example.com' } })
  const context = f.cfxServices.resolveBrowserContext({ bindingToken: f.cookie.split('=')[1]!, clientIp: '127.0.0.1' })
  expect(f.cfxServices.consumeIdentity({ context, identityTicket: ready.json().identityTicket })).toMatchObject({ id: '1' })
  expect((await f.app.inject({ method: 'GET', url, headers: { cookie: f.cookie } })).json()).not.toHaveProperty('identity')
})

it('rejects HEAD callbacks without completing the attempt before a valid GET callback', async () => {
  const f = await enabled(true)
  const headers = { cookie: f.cookie, 'sec-fetch-site': 'cross-site' }
  const query = new URLSearchParams({ attemptId: f.result.attemptId, payload: f.payload })
  const callbackUrl = `/api/auth/cfx/callback?${query}`
  const statusUrl = `/api/auth/cfx/attempts/${f.result.attemptId}`

  const head = await f.app.inject({ method: 'HEAD', url: callbackUrl, headers })
  expect.soft(head.statusCode).toBe(405)
  expect.soft(head.headers.allow).toBe('GET')
  expect(head.body).toBe('')
  expect(head.headers['cache-control']).toBe('no-store')
  expect(head.headers['referrer-policy']).toBe('no-referrer')
  expect(head.headers['x-content-type-options']).toBe('nosniff')
  const pending = await f.app.inject({ method: 'GET', url: statusUrl, headers: { cookie: f.cookie } })
  expect(pending.statusCode).toBe(200)
  expect.soft(pending.json().state).toBe('pending')

  const get = await f.app.inject({ method: 'GET', url: callbackUrl, headers })
  expect.soft(get.statusCode).toBe(200)
  expect.soft(compileComponentSchema('CfxCompletion')(get.json())).toBe(true)
  const ready = await f.app.inject({ method: 'GET', url: statusUrl, headers: { cookie: f.cookie } })
  expect(ready.statusCode).toBe(200)
  expect(ready.json().state).toBe('ready')
  expect(compileComponentSchema('CfxAttemptStatus')(ready.json())).toBe(true)
})

it('accepts production GET callbacks and keeps secrets out of the actual log stream', async () => {
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  const f = await enabled(true, { stream, serializers: { req: value => value, res: value => value } })
  expect(String(f.created.headers['set-cookie'])).toMatch(/^__Host-exwebsite\.cfx\.browser=.*;.*Secure/)
  expect(new URL(f.authorization.searchParams.get('auth_redirect')!).pathname).toBe('/api/auth/cfx/callback')
  const query = new URLSearchParams({ attemptId: f.result.attemptId, payload: f.payload })
  const url = `/api/auth/cfx/callback?${query}`
  const duplicate = await f.app.inject({ method: 'GET', url: `${url}&payload=x`, headers: { cookie: f.cookie } })
  expect(duplicate.statusCode).toBe(400)
  const response = await f.app.inject({ method: 'GET', url, headers: { cookie: f.cookie, 'sec-fetch-site': 'cross-site' } })
  expect(response.statusCode).toBe(200)
  await f.app.inject({ method: 'GET', url, headers: { cookie: f.cookie } })
  await f.app.inject({ method: 'GET', url: '/unknown?payload=EXTRA_SECRET', headers: { cookie: f.cookie } })
  const ready = (await f.app.inject({ method: 'GET', url: `/api/auth/cfx/attempts/${f.result.attemptId}`, headers: { cookie: f.cookie } })).json()
  await f.app.close()
  const log = lines.join('')
  for (const secret of [f.cookie, f.cookie.split('=')[1], f.payload, encodeURIComponent(f.payload), 'PRIVATE_CFX_KEY', f.authorization.searchParams.get('nonce'), 'private@example.com', ready.identityTicket, 'EXTRA_SECRET']) {
    expect(log).not.toContain(secret)
  }
  expect(log).toContain('incoming request')
})

it('validates all raw status branches and bidirectional operation coverage from the Contract', async () => {
  let time = 0, hold = false, release!: (response: Response) => void
  const f = await enabled(false, false, { now: () => time, fetch: async url => {
    if (hold) return new Promise<Response>(resolve => { release = resolve })
    return Response.json(url.includes('/session/') ? { current_user: { id: 1, username: 'Member', avatar_template: '/{size}.png' } } : { email: 'member@example.com' })
  } })
  const context = f.cfxServices.resolveBrowserContext({ bindingToken: f.cookie.split('=')[1]!, clientIp: '127.0.0.1' })
  const request = { server: f.app, params: { id: f.result.attemptId }, cfxContext: context }
  const validate = compileComponentSchema('CfxAttemptStatus')
  const raw = await serviceHandlers.getCfxAttempt(request as never)
  expect(validate(raw)).toBe(true)
  expect(validate({ ...raw, identity: {} })).toBe(false)
  const declared = listOperations(readContract()).map(operation => operation.operationId).sort()
  expect(Object.keys(serviceHandlers).sort()).toEqual(declared)
  const reply = { code(_code: number) { return this }, header(_name: string, _value: string) { return this } }
  const create = () => serviceHandlers.createCfxAttempt({ server: f.app, headers: { cookie: f.cookie }, ip: '127.0.0.1' } as never, reply as never)
  const get = (id: string) => serviceHandlers.getCfxAttempt({ ...request, params: { id } } as never)
  const cancel = (id: string) => serviceHandlers.cancelCfxAttempt({ ...request, params: { id } } as never)
  const payload = (url: string, changes = {}) => {
    const authorization = new URL(url)
    return publicEncrypt({ key: createPublicKey(authorization.searchParams.get('public_key')!), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(JSON.stringify({ key: 'RAW_KEY', nonce: authorization.searchParams.get('nonce'), api: 4, push: false, ...changes }))).toString('base64')
  }
  const complete = (attempt: Awaited<ReturnType<typeof create>>, changes = {}) => serviceHandlers.completeCfxManualAttempt({ ...request,
    params: { id: attempt.attemptId }, body: { payload: payload(attempt.authorizationUrl, changes) } } as never)
  const assertStatus = async (id: string, state: string) => {
    const value = await get(id)
    expect(value.state).toBe(state); expect(validate(value)).toBe(true)
    expect(validate({ ...value, secret: 'x' })).toBe(false)
    expect(validate({ ...value, expiresAt: 'invalid' })).toBe(false)
    return value
  }
  const second = await create()
  expect(compileComponentSchema('CfxAttemptCreated')(second)).toBe(true)
  expect(compileComponentSchema('CfxCompletion')(await complete(second))).toBe(true)
  const ready = await assertStatus(second.attemptId, 'ready')
  if (ready.state !== 'ready') throw new Error('expected ready')
  f.cfxServices.consumeIdentity({ context, identityTicket: ready.identityTicket })
  await assertStatus(second.attemptId, 'consumed')
  expect(compileComponentSchema('CfxCancellation')(await cancel(f.result.attemptId))).toBe(true)
  await assertStatus(f.result.attemptId, 'cancelled')
  const failed = await create()
  await expect(complete(failed, { api: 3 })).rejects.toMatchObject({ code: 'CFX_API_VERSION_UNSUPPORTED' })
  await assertStatus(failed.attemptId, 'failed')
  const processing = await create(); hold = true
  const task = complete(processing).catch(error => error)
  await assertStatus(processing.attemptId, 'processing')
  await cancel(processing.attemptId)
  release(Response.json({})); expect(await task).toMatchObject({ code: 'CFX_ATTEMPT_CONFLICT' }); hold = false
  const expired = await create(); time = 600000
  await assertStatus(expired.attemptId, 'expired')
  expect(compileComponentSchema('CfxCancellation')(await cancel(expired.attemptId))).toBe(true)

  const redirected = await enabled(true)
  const callbackContext = redirected.cfxServices.resolveBrowserContext({ bindingToken: redirected.cookie.split('=')[1]!, clientIp: '127.0.0.1' })
  const callback = await serviceHandlers.receiveCfxCallback({ server: redirected.app, cfxContext: callbackContext, query: { attemptId: redirected.result.attemptId, payload: redirected.payload } } as never)
  expect(compileComponentSchema('CfxCompletion')(callback)).toBe(true)
})

it('registers all five Cfx operations and returns disabled with safe headers by default', async () => {
  const fixture = await createTestAuth(); fixtures.push(fixture)
  const app = createApp(fixture); apps.push(app)
  const response = await app.inject({ method: 'POST', url: '/api/auth/cfx/attempts', payload: {} })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('CFX_DISABLED')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['referrer-policy']).toBe('no-referrer')
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  for (const name of ['createCfxAttempt', 'completeCfxManualAttempt', 'receiveCfxCallback', 'getCfxAttempt', 'cancelCfxAttempt']) {
    expect(Object.keys(serviceHandlers)).toContain(name)
  }
})
