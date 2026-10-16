import { request as httpRequest } from 'node:http'
import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { parseCfxConfig } from '@server/src/modules/cfx/config'

const fixtures: TestAuth[] = [], apps: ReturnType<typeof createApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

async function processingSocket() {
  const fixture = await createTestAuth(); fixtures.push(fixture)
  let notify!: () => void, release!: (response: Response) => void, signal!: AbortSignal
  const entered = new Promise<void>(resolve => { notify = resolve })
  const cfxServices = createCfxServices({ config: parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: 'development', SERVER_PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:8080' }),
    fetch: (_url, init) => { signal = init.signal!; notify(); return new Promise<Response>(resolve => { release = resolve }) } })
  const app = createApp({ ...fixture, cfxServices }); apps.push(app)
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const created = await fetch(`${address}/api/auth/cfx/attempts`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080', 'Content-Type': 'application/json' }, body: '{}' })
  expect(created.status).toBe(201)
  const result = await created.json() as { attemptId: string; authorizationUrl: string }
  const cookie = created.headers.get('set-cookie')!.split(';')[0]!
  const authorization = new URL(result.authorizationUrl)
  const payload = publicEncrypt({ key: createPublicKey(authorization.searchParams.get('public_key')!), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(JSON.stringify({ key: 'SOCKET_KEY', nonce: authorization.searchParams.get('nonce'), api: 4, push: false }))).toString('base64')
  let responseStatus: number | undefined, responseBody = ''
  const socket = httpRequest(`${address}/api/auth/cfx/attempts/${result.attemptId}/complete`, { method: 'POST',
    headers: { Origin: 'http://127.0.0.1:8080', Cookie: cookie, 'Content-Type': 'application/json' } }, response => {
    responseStatus = response.statusCode
    response.on('data', chunk => { responseBody += String(chunk) })
  })
  socket.on('error', () => {})
  socket.end(JSON.stringify({ payload }))
  await entered
  const context = cfxServices.resolveBrowserContext({ bindingToken: cookie.split('=')[1]!, clientIp: '127.0.0.1' })
  return { app, socket, cfxServices, context, result, signal: () => signal,
    release: () => release(Response.json({ current_user: { id: 1, username: 'Member', avatar_template: '/{size}' } })),
    response: () => ({ status: responseStatus, body: responseBody }) }
}

it('a disconnected completion socket cancels work and a late upstream result cannot restore identity', async () => {
  const f = await processingSocket()
  f.socket.destroy()
  await vi.waitFor(() => expect(f.signal().aborted).toBe(true))
  expect(f.cfxServices.inspect(f.context, f.result.attemptId)).toMatchObject({ state: 'cancelled' })
  f.release()
  await new Promise(resolve => setImmediate(resolve))
  expect(f.cfxServices.inspect(f.context, f.result.attemptId)).not.toHaveProperty('identity')
})

it('Fastify close aborts active completion before waiting for the HTTP request', async () => {
  const f = await processingSocket()
  const close = f.app.close()
  await vi.waitFor(() => expect(f.signal().aborted).toBe(true))
  await close
  f.release()
  await vi.waitFor(() => {
    expect(f.response().status).toBe(503)
    expect(JSON.parse(f.response().body).error.code).toBe('CFX_SERVICE_CLOSED')
  })
  f.socket.destroy()
})
