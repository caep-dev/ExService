import { constants, createPublicKey, generateKeyPairSync, publicEncrypt } from 'node:crypto'
import { isolatedPostgres } from '../helpers/postgres'
import { AuthService } from '@server/src/modules/auth/service'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { IdentityLinkService } from '@server/src/modules/identity-links/service'
import { RegistrationService, type RegistrationMailer } from '@server/src/modules/registration/service'
import type { PasswordHasher } from '@server/src/modules/auth/crypto'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export async function fixture(
  options: {
    mailer?: RegistrationMailer
    passwordHasher?: PasswordHasher
    generateKeys?: () => Promise<typeof keys>
    disabled?: boolean
  } = {},
) {
  const pg = await isolatedPostgres()
  let now = 1_800_000_000_000
  const hasher = options.passwordHasher ?? {
    hash: async (password: string) => `hash:${password}`,
    verify: async (password: string, hash: string) => hash === `hash:${password}`,
  }
  const auth = new AuthService({ db: pg.db, passwordHasher: hasher, now: () => now })
  const external = { id: 123, username: 'CfxUser', email: 'cfx@example.com' }
  const cfx = createCfxServices({
    config: options.disabled
      ? { enabled: false }
      : {
          enabled: true,
          mode: 'manual',
          publicOrigin: 'http://127.0.0.1:8080',
          applicationName: 'ExWebsite',
        },
    now: () => now,
    wallNow: () => now,
    generateKeys: options.generateKeys ?? (async () => keys),
    fetch: async (url) =>
      Response.json(
        String(url).includes('/session/')
          ? {
              current_user: {
                id: external.id,
                username: external.username,
                avatar_template: '/avatar/{size}.png',
              },
            }
          : { email: external.email, associated_accounts: [] },
      ),
  })
  const links = new IdentityLinkService({ db: pg.db, auth, cfx, now: () => now })
  const mail: Array<{ recipient: string; code: string; attemptId: string; signal: AbortSignal }> = []
  const deps = {
    db: pg.db,
    auth,
    cfx,
    identityLinks: links,
    passwordHasher: hasher,
    codeHmacKey: Buffer.alloc(32, 3),
    now: () => now,
    mailer: options.mailer ?? {
      send: async (input: Parameters<RegistrationMailer['send']>[0]) => {
        mail.push(input)
      },
    },
  }
  const registration = new RegistrationService(deps)
  await registration.start()
  const f = {
    ...pg,
    auth,
    cfx,
    links,
    registration,
    mail,
    deps,
    external,
    advance: (ms: number) => {
      now += ms
    },
    async user(email = 'owner@example.com') {
      return pg.db.transaction(async (tx) => {
        const user = await auth.createAccountInside(tx, { email, nickname: 'Owner' }, 'hash:password123')
        const login = await auth.createSessionInside(tx, user.id)
        return { user, login }
      })
    },
    async ready(attempt?: Awaited<ReturnType<typeof cfx.begin>>) {
      const begun = attempt ?? (await cfx.begin({ clientIp: '127.0.0.1' }))
      const context = cfx.resolveBrowserContext({ bindingToken: begun.cookieValue, clientIp: '127.0.0.1' })
      const url = new URL(begun.response.authorizationUrl)
      const payload = publicEncrypt(
        {
          key: createPublicKey(url.searchParams.get('public_key')!),
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha1',
        },
        Buffer.from(
          JSON.stringify({ key: 'TEST_KEY', nonce: url.searchParams.get('nonce'), api: 4, push: false }),
        ),
      ).toString('base64')
      await cfx.complete({ context, attemptId: begun.response.attemptId, payload, source: 'manual' })
      const status = cfx.inspect(context, begun.response.attemptId)
      if (status.state !== 'ready') throw new Error('Expected real ready proof')
      return { begun, context, ticket: status.identityTicket, attemptId: status.attemptId }
    },
    async grant(email = 'new@example.com', binding = 'browser') {
      const challenge = await registration.requestCode(email, binding)
      // The mail boundary starts asynchronously after the durable reservation.
      while (!mail.some((item) => item.recipient === email))
        await new Promise((resolve) => setTimeout(resolve, 1))
      const delivered = mail.filter((item) => item.recipient === email).at(-1)!
      return registration.verifyCode(challenge.challengeId, delivered.code, binding)
    },
    async close() {
      await registration.close()
      await links.close()
      await cfx.close()
      await pg.close()
    },
  }
  return f
}
