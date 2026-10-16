import { afterEach, expect, it } from 'vitest'
import { fixture } from '../registration/fixture'
import { ExternalAccountService } from '@server/src/modules/external-accounts/service'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('rejects an identity assembled by a caller without consuming a Cfx ticket', async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const user = await f.user()
  const accounts = new ExternalAccountService({ db: f.db, auth: f.auth, cfx: f.cfx })
  await expect(f.db.transaction((tx) => accounts.createLinkInside(
    tx,
    { provider: 'cfx', subject: '123', username: 'Forged', providerEmail: 'cfx@example.com' } as never,
    user.user.id,
  ))).rejects.toThrow('Unverified external identity')
  expect((await f.db.query('SELECT id FROM auth_identity_links')).rows).toHaveLength(0)
})

it('uses a locked persisted Cfx grant snapshot to create the registration link', async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const proof = await f.ready()
  const signedIn = await f.registration.signIn(proof.context, proof.ticket, 'browser')
  expect(signedIn.kind).toBe('registration-required')
  if (signedIn.kind !== 'registration-required') return
  await f.registration.close()
  const restarted = new (await import('@server/src/modules/registration/service')).RegistrationService(f.deps)
  await restarted.start()
  cleanup.push(() => restarted.close())
  const result = await restarted.complete({
    registrationToken: signedIn.registrationToken,
    nickname: 'Restarted',
    password: 'password123',
  }, 'browser')
  const links = await f.db.query<{ external_user_id: string; user_id: string }>('SELECT external_user_id,user_id FROM auth_identity_links')
  expect(links.rows).toEqual([{ external_user_id: '123', user_id: result.result.userId }])
})
