import { afterEach, expect, it } from 'vitest'
import { fixture, deferred } from '../registration/fixture'
import type { SqlExecutor } from '@server/src/db/client'
const clean: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
})
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  clean.push(() => f.close())
  const { user, login } = await f.user()
  const session = await f.auth.authenticateToken(login.token)
  return { ...f, user, login, session }
}
it('binds a real Cfx proof despite different emails and preserves password/session after unlink', async () => {
  const f = await setup(),
    begin = await f.links.begin(f.session, { clientIp: '127.0.0.1' }),
    proof = await f.ready(begin)
  const linked = await f.links.link(f.session, proof.context, proof.attemptId, proof.ticket)
  expect(linked).toMatchObject({ provider: 'cfx', providerEmail: 'cfx@example.com', externalUserId: '123' })
  expect((await f.links.list(f.session)).providers.map((p) => p.provider)).toEqual(['cfx', 'google', 'qq'])
  await f.links.unlink(f.session)
  await f.links.unlink(f.session)
  expect((await f.links.list(f.session)).providers[0]!.link).toBeNull()
  await expect(f.auth.authenticateToken(f.login.token)).resolves.toHaveProperty('userId', f.user.id)
  await expect(f.auth.login({ email: f.user.email, password: 'password123' })).resolves.toHaveProperty(
    'token',
  )
})
it('explicitly cancels an owned attempt and releases its link reservation', async () => {
  const f = await setup()
  const attempt = await f.links.begin(f.session, { clientIp: '127.0.0.1' })
  const context = f.cfx.resolveBrowserContext({ bindingToken: attempt.cookieValue, clientIp: '127.0.0.1' })
  expect(f.links.cancelCfxAttempt(context, attempt.response.attemptId)).toMatchObject({ state: 'cancelled' })
  await expect(f.links.link(f.session, context, attempt.response.attemptId, 'invalid')).rejects.toMatchObject({
    code: 'IDENTITY_LINK_ATTEMPT_INVALID',
  })
})
it('rejects an unexpected stored provider instead of exposing it as a Cfx link', async () => {
  const f = await setup()
  const invalidStorage: SqlExecutor = {
    query: async () => ({ rows: [{
      id: 'unexpected', user_id: f.user.id, provider: 'google', external_user_id: 'external',
      external_username: 'Unexpected', provider_email: 'unexpected@example.com', linked_at: 1,
    }], rowCount: 1 }),
  } as unknown as SqlExecutor
  await expect(f.links.listInside(invalidStorage, f.user.id)).rejects.toThrow('Unexpected identity provider')
})
it('rejects another attempt ticket without consuming it and permanently ends the mismatched intent', async () => {
  const f = await setup(),
    first = await f.links.begin(f.session, { clientIp: '127.0.0.1' })
  const second = await f.links.begin(f.session, { clientIp: '127.0.0.1', bindingToken: first.cookieValue })
  const a = await f.ready(first),
    b = await f.ready(second)
  await expect(f.links.link(f.session, a.context, a.attemptId, b.ticket)).rejects.toMatchObject({
    code: 'CFX_IDENTITY_TICKET_INVALID',
  })
  expect(f.cfx.inspect(b.context, b.attemptId).state).toBe('ready')
  await expect(f.links.link(f.session, a.context, a.attemptId, a.ticket)).rejects.toMatchObject({
    code: 'IDENTITY_LINK_ATTEMPT_INVALID',
  })
  await expect(f.links.link(f.session, b.context, b.attemptId, b.ticket)).resolves.toHaveProperty(
    'externalUserId',
    '123',
  )
})
it('rejects a different session, logout, disabled account and unlink-invalidated ready intents', async () => {
  const f = await setup()
  const a = await f.ready(await f.links.begin(f.session, { clientIp: '127.0.0.1' }))
  const second = await f.auth.login({ email: f.user.email, password: 'password123' })
  await expect(
    f.links.link(await f.auth.authenticateToken(second.token), a.context, a.attemptId, a.ticket),
  ).rejects.toMatchObject({ code: 'IDENTITY_LINK_ATTEMPT_INVALID' })
  const b = await f.ready(await f.links.begin(f.session, { clientIp: '127.0.0.2' }))
  await f.links.unlink(f.session)
  await expect(f.links.link(f.session, b.context, b.attemptId, b.ticket)).rejects.toMatchObject({
    code: 'IDENTITY_LINK_ATTEMPT_INVALID',
  })
  const c = await f.ready(await f.links.begin(f.session, { clientIp: '127.0.0.3' }))
  await f.auth.logout(f.session)
  await expect(f.links.link(f.session, c.context, c.attemptId, c.ticket)).rejects.toMatchObject({
    code: 'SESSION_INVALID',
  })
  const session = await f.auth.authenticateToken(second.token)
  const d = await f.ready(await f.links.begin(session, { clientIp: '127.0.0.4' }))
  await f.auth.disableUser(f.user.id)
  await expect(f.links.link(session, d.context, d.attemptId, d.ticket)).rejects.toMatchObject({
    code: 'SESSION_INVALID',
  })
  expect((await f.db.query('SELECT * FROM auth_identity_links')).rows).toHaveLength(0)
})
it('invalidates asynchronous begin reservations on unlink and holds close until real key generation settles', async () => {
  // The external RSA generation boundary is delayed; the Cfx service itself remains real.
  const { generateKeyPairSync } = await import('node:crypto')
  const keyGate = deferred<ReturnType<typeof generateKeyPairSync>>()
  const f = await setup({ generateKeys: () => keyGate.promise })
  const starting = f.links.begin(f.session, { clientIp: '127.0.0.1' })
  const rejected = expect(starting).rejects.toMatchObject({ code: 'IDENTITY_LINK_ATTEMPT_INVALID' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await f.links.unlink(f.session)
  let closed = false
  const close = f.links.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(closed).toBe(false)
  keyGate.resolve(generateKeyPairSync('rsa', { modulusLength: 2048 }))
  await rejected
  await close
  expect(closed).toBe(true)
})
it('queries and unlinks stored identities with Cfx disabled', async () => {
  const f = await setup({ disabled: true })
  await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'Existing', email: 'other@example.com' }, f.user.id),
  )
  expect((await f.links.list(f.session)).providers).toMatchObject([
    { provider: 'cfx', available: false, link: { externalUserId: '123' } },
    { provider: 'google', available: false, link: null },
    { provider: 'qq', available: false, link: null },
  ])
  await f.links.unlink(f.session)
  expect((await f.links.list(f.session)).providers[0]!.link).toBeNull()
})
