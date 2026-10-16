import { afterEach, expect, it } from 'vitest'
import { isolatedPostgres } from '../helpers/postgres'
import { AuthService } from '@server/src/modules/auth/service'
import { createCfxServices } from '@server/src/modules/cfx/service'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const registration = await import('@server/src/modules/registration/service').catch(() => undefined)
  const links = await import('@server/src/modules/identity-links/service').catch(() => undefined)
  expect(registration).toBeDefined()
  expect(links).toBeDefined()
  const f = await isolatedPostgres()
  cleanup.push(f.close)
  let time = 1_800_000_000_000
  const hasher = {
    hash: async (password: string) => `hashed:${password}`,
    verify: async (password: string, hash: string) => hash === `hashed:${password}`,
  }
  const auth = new AuthService({ db: f.db, now: () => time, passwordHasher: hasher })
  const cfx = createCfxServices({ config: { enabled: false } })
  cleanup.push(() => cfx.close())
  const identityLinks = new links!.IdentityLinkService({ db: f.db, auth, cfx, now: () => time })
  cleanup.push(() => identityLinks.close())
  const mail: Array<{ code: string }> = []
  const service = new registration!.RegistrationService({
    db: f.db,
    auth,
    cfx,
    identityLinks,
    passwordHasher: hasher,
    codeHmacKey: Buffer.alloc(32, 7),
    now: () => time,
    mailer: {
      send: async (input) => {
        mail.push(input)
      },
    },
  })
  cleanup.push(() => service.close())
  await service.start()
  return {
    ...f,
    auth,
    service,
    identityLinks,
    mail,
    advance(ms: number) {
      time += ms
    },
  }
}
it('registers a bound email with Cfx disabled and rereads the original result without changing the account', async () => {
  const f = await fixture()
  const challenge = await f.service.requestCode(' User@example.com ', 'browser-a')
  await new Promise((resolve) => setTimeout(resolve, 5))
  const grant = await f.service.verifyCode(challenge.challengeId, f.mail[0]!.code, 'browser-a')
  const completed = await f.service.complete(
    { registrationToken: grant.registrationToken, nickname: 'User', password: 'password123' },
    'browser-a',
  )
  expect(completed.created).toBe(true)
  const repeated = await f.service.complete(
    { registrationToken: grant.registrationToken, nickname: 'Changed', password: 'different123' },
    'browser-a',
  )
  expect(repeated).toEqual({ ...completed, created: false })
  expect((await f.db.query('SELECT email,nickname,password_hash FROM auth_users')).rows).toEqual([
    { email: 'user@example.com', nickname: 'User', password_hash: 'hashed:password123' },
  ])
  expect((await f.db.query('SELECT * FROM auth_sessions')).rows).toHaveLength(0)
})
it('commits five failed attempts while foreign browser requests do not increment the counter', async () => {
  const f = await fixture(),
    challenge = await f.service.requestCode('user@example.com', 'browser-a')
  await expect(f.service.verifyCode(challenge.challengeId, 'bad', 'browser-b')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_INVALID',
  })
  expect((await f.db.query('SELECT failed_attempts FROM auth_registration_emails')).rows[0]).toEqual({
    failed_attempts: 0,
  })
  for (let i = 0; i < 5; i++)
    await expect(f.service.verifyCode(challenge.challengeId, 'bad', 'browser-a')).rejects.toMatchObject({
      code: i === 4 ? 'REGISTRATION_CODE_LOCKED' : 'REGISTRATION_CODE_INVALID',
    })
  expect((await f.db.query('SELECT failed_attempts FROM auth_registration_emails')).rows[0]).toEqual({
    failed_attempts: 5,
  })
  f.advance(61_000)
  await expect(f.service.requestCode('user@example.com', 'browser-a')).rejects.toMatchObject({
    code: 'REGISTRATION_CODE_LOCKED',
  })
})
it('preserves a valid code when the browser grant capacity is full', async () => {
  const f = await fixture()
  for (let i = 0; i < 3; i++) {
    const challenge = await f.service.requestCode(`u${i}@example.com`, 'browser-a')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await f.service.verifyCode(challenge.challengeId, f.mail.at(-1)!.code, 'browser-a')
  }
  const challenge = await f.service.requestCode('fourth@example.com', 'browser-a')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await expect(
    f.service.verifyCode(challenge.challengeId, f.mail.at(-1)!.code, 'browser-a'),
  ).rejects.toMatchObject({ code: 'REGISTRATION_CAPACITY_EXCEEDED' })
  expect(
    (await f.db.query('SELECT code_hmac FROM auth_registration_emails WHERE id=$1', [challenge.challengeId]))
      .rows[0]!.code_hmac,
  ).not.toBeNull()
})
