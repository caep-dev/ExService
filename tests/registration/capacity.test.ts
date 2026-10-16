import { afterEach, expect, it } from 'vitest'
import { fixture } from './fixture'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup() {
  const f = await fixture({ disabled: true })
  cleanup.push(() => f.close())
  return f
}
it.each([
  ['active', 256],
  ['failed', 1024],
] as const)('enforces global %s grant budget without consuming a valid email code', async (state, count) => {
  const f = await setup(),
    challenge = await f.registration.requestCode('new@example.com', 'browser')
  await f.db.query(
    `INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,state,expires_at,created_at)
    SELECT gen_random_uuid()::text,'token-'||i,'binding-'||i,'email','u'||i||'@example.com',$1,1800001800000,1800000000000 FROM generate_series(1,$2) i`,
    [state, count],
  )
  await expect(
    f.registration.verifyCode(challenge.challengeId, f.mail[0]!.code, 'browser'),
  ).rejects.toMatchObject({ code: 'REGISTRATION_CAPACITY_EXCEEDED', retryAfterSeconds: 60 })
  expect(
    (await f.db.query('SELECT code_hmac FROM auth_registration_emails WHERE id=$1', [challenge.challengeId]))
      .rows[0]!.code_hmac,
  ).not.toBeNull()
})
it('serializes two grant admissions at the global boundary and preserves the losing code', async () => {
  const f = await setup()
  const a = await f.registration.requestCode('a@example.com', 'a'),
    b = await f.registration.requestCode('b@example.com', 'b')
  await f.db
    .query(`INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,state,expires_at,created_at)
    SELECT gen_random_uuid()::text,'token-'||i,'binding-'||i,'email','u'||i||'@example.com','active',1800001800000,1800000000000 FROM generate_series(1,255) i`)
  const results = await Promise.allSettled([
    f.registration.verifyCode(a.challengeId, f.mail.find((m) => m.recipient === 'a@example.com')!.code, 'a'),
    f.registration.verifyCode(b.challengeId, f.mail.find((m) => m.recipient === 'b@example.com')!.code, 'b'),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
    { reason: { code: 'REGISTRATION_CAPACITY_EXCEEDED' } },
  ])
  expect(
    (await f.db.query('SELECT code_hmac FROM auth_registration_emails WHERE code_hmac IS NOT NULL')).rows,
  ).toHaveLength(1)
  expect(Number((await f.db.query('SELECT count(*) FROM auth_registration_grants')).rows[0]!.count)).toBe(256)
})
it('limits durable emails to 1024 and releases the mail execution reservation on refusal', async () => {
  const f = await setup()
  await f.db.query(`INSERT INTO auth_registration_emails(id,email,next_send_at,updated_at)
    SELECT gen_random_uuid()::text,'u'||i||'@example.com',1800000060000,1800000000000 FROM generate_series(1,1024) i`)
  for (let i = 0; i < 5; i++)
    await expect(f.registration.requestCode('extra@example.com', 'browser')).rejects.toMatchObject({
      code: 'REGISTRATION_CAPACITY_EXCEEDED',
    })
  await f.db.query(`DELETE FROM auth_registration_emails WHERE email='u1@example.com'`)
  await expect(f.registration.requestCode('extra@example.com', 'browser')).resolves.toHaveProperty(
    'status',
    'accepted',
  )
})
it('limits durable deliveries to 4096 without mutating cooldown or code version', async () => {
  const f = await setup(),
    challenge = await f.registration.requestCode('new@example.com', 'browser')
  await f.registration.verifyCode(challenge.challengeId, f.mail[0]!.code, 'browser')
  await f.db.query(
    `INSERT INTO auth_registration_deliveries(id,registration_email_id,code_version,status,created_at,finished_at)
    SELECT gen_random_uuid()::text,$1,i,'failed',1800000000000,1800000000000 FROM generate_series(2,4096) i`,
    [challenge.challengeId],
  )
  f.advance(60_000)
  await expect(f.registration.requestCode('new@example.com', 'browser')).rejects.toMatchObject({
    code: 'REGISTRATION_CAPACITY_EXCEEDED',
  })
  expect((await f.db.query('SELECT code_version,next_send_at FROM auth_registration_emails')).rows).toEqual([
    { code_version: 1, next_send_at: 1800000060000 },
  ])
})
it('retains failure windows across resend and denies the superseded browser without charging it', async () => {
  const f = await setup(),
    challenge = await f.registration.requestCode('new@example.com', 'first')
  for (let i = 0; i < 3; i++)
    await expect(f.registration.verifyCode(challenge.challengeId, 'bad', 'first')).rejects.toMatchObject({
      code: 'REGISTRATION_CODE_INVALID',
    })
  f.advance(60_000)
  const resent = await f.registration.requestCode('new@example.com', 'second')
  expect(resent.challengeId).toBe(challenge.challengeId)
  await expect(f.registration.verifyCode(challenge.challengeId, 'bad', 'first')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_INVALID',
  })
  expect((await f.db.query('SELECT failed_attempts FROM auth_registration_emails')).rows).toEqual([
    { failed_attempts: 3 },
  ])
  await expect(f.registration.verifyCode(challenge.challengeId, 'bad', 'second')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_INVALID',
  })
  await expect(f.registration.verifyCode(challenge.challengeId, 'bad', 'second')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_LOCKED',
    retryAfterSeconds: 540,
  })
})
it('terminates the losing email grant after a concurrent unique account race', async () => {
  const f = await setup(),
    a = await f.grant('new@example.com', 'a')
  f.advance(60_000)
  const b = await f.grant('new@example.com', 'b')
  const results = await Promise.allSettled([
    f.registration.complete(
      { registrationToken: a.registrationToken, nickname: 'First', password: 'password123' },
      'a',
    ),
    f.registration.complete(
      { registrationToken: b.registrationToken, nickname: 'Second', password: 'password123' },
      'b',
    ),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'EMAIL_IN_USE' } }])
  expect((await f.db.query('SELECT state FROM auth_registration_grants ORDER BY state')).rows).toEqual([
    { state: 'completed' },
    { state: 'failed' },
  ])
  expect((await f.db.query('SELECT id FROM auth_users')).rows).toHaveLength(1)
})
