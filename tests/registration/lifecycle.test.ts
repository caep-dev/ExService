import { afterEach, expect, it, vi } from 'vitest'
import { fixture, deferred } from './fixture'
import { RegistrationService } from '@server/src/modules/registration/service'
import { AuthError } from '@server/src/modules/auth/errors'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  cleanup.push(() => f.close())
  return f
}
it('keeps completed results for five minutes after completion even past original grant expiry', async () => {
  const f = await setup(),
    proof = await f.ready(),
    grant = await f.registration.signIn(proof.context, proof.ticket, 'browser')
  if (grant.kind !== 'registration-required') throw new Error('Expected grant')
  f.advance(299_000)
  const input = { registrationToken: grant.registrationToken, nickname: 'Original', password: 'password123' }
  const first = await f.registration.complete(input, 'browser')
  f.advance(299_000)
  expect(await f.registration.complete({ ...input, nickname: 'Changed' }, 'browser')).toEqual({
    ...first,
    created: false,
  })
  f.advance(1000)
  await expect(f.registration.complete(input, 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_GRANT_INVALID',
  })
})
it('persists consumed Cfx grants across service restart while completed registration links atomically', async () => {
  const f = await setup(),
    proof = await f.ready(),
    grant = await f.registration.signIn(proof.context, proof.ticket, 'browser')
  if (grant.kind !== 'registration-required') throw new Error('Expected grant')
  await f.registration.close()
  const restarted = new RegistrationService(f.deps)
  cleanup.push(() => restarted.close())
  await restarted.start()
  const result = await restarted.complete(
    { registrationToken: grant.registrationToken, nickname: 'Member', password: 'password123' },
    'browser',
  )
  const links = await f.links.listInside(f.db, result.result.userId)
  expect(links).toMatchObject([{ externalUserId: '123', providerEmail: 'cfx@example.com' }])
  expect(() => f.cfx.consumeIdentity({ context: proof.context, identityTicket: proof.ticket })).toThrow(
    expect.objectContaining({ code: 'CFX_IDENTITY_TICKET_INVALID' }),
  )
})
it('terminates rejected hash grants and does not retry another set of credentials', async () => {
  const f = await setup({
      passwordHasher: {
        hash: async () => {
          throw new AuthError('AUTH_BUSY', { retryAfterSeconds: 1 })
        },
        verify: async () => false,
      },
    }),
    grant = await f.grant()
  const input = { registrationToken: grant.registrationToken, nickname: 'Member', password: 'password123' }
  await expect(f.registration.complete(input, 'browser')).rejects.toMatchObject({ code: 'AUTH_BUSY' })
  await expect(f.registration.complete(input, 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_RESTART_REQUIRED',
  })
  expect((await f.db.query('SELECT state FROM auth_registration_grants')).rows).toEqual([{ state: 'failed' }])
  expect((await f.db.query('SELECT * FROM auth_users')).rows).toHaveLength(0)
})
it('allows only one in-flight hash per grant and waits for real hash settlement on close', async () => {
  const gate = deferred<string>(),
    entered = deferred()
  const f = await setup({
      passwordHasher: {
        hash: async () => {
          entered.resolve()
          return gate.promise
        },
        verify: async () => false,
      },
    }),
    grant = await f.grant()
  const input = { registrationToken: grant.registrationToken, nickname: 'Member', password: 'password123' }
  const first = f.registration.complete(input, 'browser')
  await entered.promise
  await expect(f.registration.complete(input, 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_IN_PROGRESS',
  })
  let closed = false
  const close = f.registration.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(closed).toBe(false)
  await expect(f.registration.requestCode('late@example.com', 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_CAPACITY_EXCEEDED',
  })
  gate.resolve('settled-hash')
  await first
  await close
  expect((await f.db.query('SELECT password_hash FROM auth_users')).rows).toEqual([
    { password_hash: 'settled-hash' },
  ])
})
it('rolls back the losing account when two Cfx grants compete for the same identity', async () => {
  const f = await setup(),
    a = await f.ready(),
    ga = await f.registration.signIn(a.context, a.ticket, 'a')
  f.external.email = 'changed@example.com'
  const b = await f.ready(),
    gb = await f.registration.signIn(b.context, b.ticket, 'b')
  if (ga.kind !== 'registration-required' || gb.kind !== 'registration-required')
    throw new Error('Expected two grants')
  await f.registration.complete(
    { registrationToken: ga.registrationToken, nickname: 'First', password: 'password123' },
    'a',
  )
  await expect(
    f.registration.complete(
      { registrationToken: gb.registrationToken, nickname: 'Second', password: 'password123' },
      'b',
    ),
  ).rejects.toMatchObject({ code: 'IDENTITY_LINK_CONFLICT' })
  expect((await f.db.query('SELECT email FROM auth_users')).rows).toEqual([{ email: 'cfx@example.com' }])
  expect((await f.db.query('SELECT state FROM auth_registration_grants ORDER BY email')).rows).toEqual([
    { state: 'completed' },
    { state: 'failed' },
  ])
})
it('uses the current link ahead of provider email and never automatically merges an existing email', async () => {
  const f = await setup(),
    { user } = await f.user(),
    proof = await f.ready()
  await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'CfxUser', email: 'old@example.com' }, user.id),
  )
  const signed = await f.registration.signIn(proof.context, proof.ticket, 'browser')
  if (signed.kind !== 'signed-in') throw new Error('Expected login')
  expect((await f.auth.authenticateToken(signed.token)).userId).toBe(user.id)
  const session = await f.auth.authenticateToken(signed.token)
  await f.links.unlink(session)
  f.external.email = user.email
  const second = await f.ready()
  expect(await f.registration.signIn(second.context, second.ticket, 'browser')).toEqual({
    kind: 'account-exists',
    email: user.email,
    nextAction: 'login_then_link',
  })
  expect((await f.db.query('SELECT * FROM auth_identity_links')).rows).toHaveLength(0)
})
it.each([
  ['a'.repeat(80), 'a'.repeat(32)],
  ['😀'.repeat(40), '😀'.repeat(32)],
])('truncates Cfx nickname suggestions to 32 code points: %s', async (username, suggestion) => {
  const f = await setup()
  f.external.username = username
  const proof = await f.ready()
  expect(await f.registration.signIn(proof.context, proof.ticket, 'browser')).toMatchObject({
    kind: 'registration-required',
    suggestedNickname: suggestion,
  })
})
it('keeps all four mail slots occupied after timeout until the adapters actually settle', async () => {
  const gate = deferred(),
    signals: AbortSignal[] = []
  const f = await setup({
    mailer: {
      send: async (input) => {
        signals.push(input.signal)
        await gate.promise
      },
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    for (let i = 0; i < 4; i++) await f.registration.requestCode(`u${i}@example.com`, 'browser')
    expect(signals).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await expect(f.registration.requestCode('fifth@example.com', 'browser')).rejects.toMatchObject({
      code: 'REGISTRATION_CAPACITY_EXCEEDED',
    })
    let closed = false
    const close = f.registration.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    gate.resolve()
    await close
    expect((await f.db.query('SELECT status FROM auth_registration_deliveries')).rows).toEqual(
      Array(4).fill({ status: 'failed' }),
    )
  } finally {
    gate.resolve()
    vi.useRealTimers()
  }
})
it('retains cooldown and usable codes after delivery failure and marks crash leftovers failed without replay', async () => {
  let code = ''
  const f = await setup({
    mailer: {
      send: async (input) => {
        code = input.code
        throw new Error('provider secret')
      },
    },
  })
  const challenge = await f.registration.requestCode('new@example.com', 'browser')
  await expect(f.registration.requestCode('new@example.com', 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_RESEND_TOO_SOON',
  })
  const grant = await f.registration.verifyCode(challenge.challengeId, code, 'browser')
  expect(grant.email).toBe('new@example.com')
  await f.registration.close()
  await f.db.query(`UPDATE auth_registration_deliveries SET status='pending',finished_at=NULL`)
  const restarted = new RegistrationService({ ...f.deps, mailer: undefined })
  cleanup.push(() => restarted.close())
  await restarted.start()
  expect((await f.db.query('SELECT status FROM auth_registration_deliveries')).rows).toEqual([
    { status: 'failed' },
  ])
  await expect(restarted.requestCode('other@example.com', 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_MAIL_UNAVAILABLE',
    retryAfterSeconds: 60,
  })
})
it('enforces shared IP limits without evicting live counters and resets only after the window', async () => {
  const f = await setup()
  for (let i = 0; i < 60; i++) f.registration.limitIp('one')
  expect(() => f.registration.limitIp('one')).toThrow(
    expect.objectContaining({ statusCode: 429, retryAfterSeconds: 60 }),
  )
  for (let i = 0; i < 1023; i++) f.registration.limitIp(`other-${i}`)
  expect(() => f.registration.limitIp('overflow')).toThrow(
    expect.objectContaining({ code: 'REGISTRATION_CAPACITY_EXCEEDED' }),
  )
  f.advance(60_000)
  expect(() => f.registration.limitIp('overflow')).not.toThrow()
})
it('cleans at most 25 expired grants per timer tick and retains deliveries for 24 hours', async () => {
  const f = await setup(),
    challenge = await f.registration.requestCode('new@example.com', 'browser')
  await f.registration.close()
  await f.db
    .query(`INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,state,expires_at,created_at)
    SELECT gen_random_uuid()::text,'expired-'||i,'browser','email','u'||i||'@example.com','failed',1799999999999,1799999900000 FROM generate_series(1,60) i`)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const restarted = new RegistrationService(f.deps)
  cleanup.push(() => restarted.close())
  await restarted.start()
  await vi.advanceTimersByTimeAsync(1000)
  await restarted.close()
  expect(Number((await f.db.query('SELECT count(*) FROM auth_registration_grants')).rows[0]!.count)).toBe(35)
  expect((await f.db.query('SELECT registration_email_id FROM auth_registration_deliveries')).rows).toEqual([
    { registration_email_id: challenge.challengeId },
  ])
})
it('fails an expired grant after real password work settles without creating an account', async () => {
  const gate = deferred<string>(),
    entered = deferred()
  const f = await setup({
      passwordHasher: {
        hash: async () => {
          entered.resolve()
          return gate.promise
        },
        verify: async () => false,
      },
    }),
    grant = await f.grant()
  const pending = f.registration.complete(
    { registrationToken: grant.registrationToken, nickname: 'Member', password: 'password123' },
    'browser',
  )
  const failed = expect(pending).rejects.toMatchObject({ code: 'REGISTRATION_GRANT_INVALID' })
  await entered.promise
  f.advance(1_800_000)
  gate.resolve('hash')
  await failed
  expect((await f.db.query('SELECT * FROM auth_users')).rows).toHaveLength(0)
  expect((await f.db.query('SELECT state FROM auth_registration_grants')).rows).toEqual([{ state: 'failed' }])
})
