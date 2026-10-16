import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import { compileComponentSchema } from '@tests/helpers/contract'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { parseCfxConfig } from '@server/src/modules/cfx/config'
import { IdentityLinkService } from '@server/src/modules/identity-links/service'

const fixtures: TestAuth[] = [], apps: ReturnType<typeof createApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

async function setup() {
  const fixture = await createTestAuth()
  fixtures.push(fixture)
  const cfxServices = createCfxServices({
    config: parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: 'development',
      SERVER_PUBLIC_WEB_BASE_URL: fixture.publicOrigin }),
    now: fixture.now, wallNow: fixture.now,
    fetch: async url => Response.json(url.includes('/session/')
      ? { current_user: { id: 123, username: 'CfxUser', avatar_template: '/avatar/{size}.png' } }
      : { email: 'cfx@example.com' }),
  })
  const identityLinkServices = new IdentityLinkService({
    db: fixture.db, auth: fixture.authServices, cfx: cfxServices, now: fixture.now,
  })
  const app = createApp({ ...fixture, cfxServices, identityLinkServices })
  apps.push(app)
  await fixture.seedUser({ email: 'owner@example.com', nickname: 'Owner', password: 'valid password' })
  const { token } = await fixture.authServices.login({ email: 'owner@example.com', password: 'valid password' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const headers = { authorization: `Bearer ${token}`, origin: fixture.publicOrigin }
  async function begin(cookie?: string) {
    return fetch(`${address}/api/auth/me/identity-links/cfx/attempts`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: '{}',
    })
  }
  async function cancel(id: string, cookie: string) {
    return fetch(`${address}/api/auth/cfx/attempts/${id}`, { method: 'DELETE', headers: { ...headers, cookie } })
  }
  return { fixture, app, address, headers, begin, cancel }
}

it('admits a fourth owner link attempt immediately after three cancellations', async () => {
  const f = await setup()
  let cookie: string | undefined
  for (let index = 0; index < 3; index++) {
    const begun = await f.begin(cookie)
    expect(begun.status).toBe(201)
    cookie = begun.headers.get('set-cookie')!.split(';')[0]!
    const attempt = await begun.json()
    expect(compileComponentSchema('CfxAttemptCreated')(attempt)).toBe(true)
    const cancelled = await f.cancel(attempt.attemptId, cookie)
    expect(cancelled.status).toBe(200)
    const result = await cancelled.json()
    expect(result).toMatchObject({ attemptId: attempt.attemptId, state: 'cancelled' })
    expect(compileComponentSchema('CfxCancellation')(result)).toBe(true)
  }
  const retried = await f.begin(cookie)
  expect(retried.status).toBe(201)
  expect(compileComponentSchema('CfxAttemptCreated')(await retried.json())).toBe(true)
})

it('preserves owner capacity after a foreign browser cancellation and releases it after an owned cancellation', async () => {
  const f = await setup()
  let cookie: string | undefined
  let attemptId = ''
  for (let index = 0; index < 3; index++) {
    const begun = await f.begin(cookie)
    expect(begun.status).toBe(201)
    cookie = begun.headers.get('set-cookie')!.split(';')[0]!
    attemptId = (await begun.json()).attemptId
  }
  const foreign = await fetch(`${f.address}/api/auth/cfx/attempts`, {
    method: 'POST', headers: { origin: f.headers.origin, 'content-type': 'application/json' }, body: '{}',
  })
  expect(foreign.status).toBe(201)
  await foreign.json()
  const foreignCookie = foreign.headers.get('set-cookie')!.split(';')[0]!
  const denied = await f.cancel(attemptId, foreignCookie)
  expect(denied.status).toBe(404)
  expect(await denied.json()).toMatchObject({ error: { code: 'CFX_ATTEMPT_NOT_FOUND' } })
  const full = await f.begin(cookie)
  expect(full.status).toBe(503)
  expect(await full.json()).toMatchObject({ error: { code: 'REGISTRATION_CAPACITY_EXCEEDED' } })
  for (let index = 0; index < 2; index++) {
    const cancelled = await f.cancel(attemptId, cookie!)
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ state: 'cancelled' })
  }
  const retried = await f.begin(cookie)
  expect(retried.status).toBe(201)
  await retried.json()
})

it('retains a consumed link reservation until its locked transaction commits', async () => {
  const f = await setup()
  let cookie: string | undefined
  let first: { attemptId: string; authorizationUrl: string } | undefined
  for (let index = 0; index < 3; index++) {
    const begun = await f.begin(cookie)
    expect(begun.status).toBe(201)
    cookie = begun.headers.get('set-cookie')!.split(';')[0]!
    const attempt = await begun.json()
    first ??= attempt
  }
  const url = new URL(first!.authorizationUrl)
  const payload = publicEncrypt({ key: createPublicKey(url.searchParams.get('public_key')!),
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
  Buffer.from(JSON.stringify({ key: 'TEST_KEY', nonce: url.searchParams.get('nonce'), api: 4, push: false })))
    .toString('base64')
  const ready = await fetch(`${f.address}/api/auth/cfx/attempts/${first!.attemptId}/complete`, {
    method: 'POST', headers: { ...f.headers, cookie: cookie!, 'content-type': 'application/json' },
    body: JSON.stringify({ payload }),
  })
  expect(ready.status).toBe(200)
  expect(await ready.json()).toMatchObject({ state: 'ready' })
  const inspected = await fetch(`${f.address}/api/auth/cfx/attempts/${first!.attemptId}`, {
    headers: { cookie: cookie! },
  })
  expect(inspected.status).toBe(200)
  const proof = await inspected.json()
  expect(proof).toMatchObject({ state: 'ready' })
  const identity = await f.fixture.authServices.authenticateToken(f.headers.authorization.slice(7))
  let pending: Promise<Response> | undefined
  try {
    await f.fixture.db.transaction(async tx => {
      const blocker = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await tx.query('SELECT id FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [identity.userId])
      pending = fetch(`${f.address}/api/auth/me/identity-links/cfx`, {
        method: 'POST', headers: { ...f.headers, cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: first!.attemptId, identityTicket: proof.identityTicket }),
      })
      await vi.waitFor(async () => {
        const waiting = await f.fixture.db.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blocker])
        expect(waiting.rows).toHaveLength(1)
      }, { timeout: 5000 })
      const cancelled = await f.cancel(first!.attemptId, cookie!)
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({ state: 'consumed' })
      const full = await f.begin(cookie)
      expect(full.status).toBe(503)
      expect(await full.json()).toMatchObject({ error: { code: 'REGISTRATION_CAPACITY_EXCEEDED' } })
    })
    const linked = await pending!
    expect(linked.status).toBe(201)
    expect(await linked.json()).toMatchObject({ provider: 'cfx', externalUserId: '123' })
    const retried = await f.begin(cookie)
    expect(retried.status).toBe(201)
    await retried.json()
  } finally {
    await pending
  }
})
