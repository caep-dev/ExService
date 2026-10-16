import { afterEach, expect, it } from 'vitest'
import { fixture, deferred } from '../registration/fixture'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup() {
  const f = await fixture()
  cleanup.push(() => f.close())
  const { user, login } = await f.user()
  const session = await f.auth.authenticateToken(login.token)
  return { ...f, createUser: f.user, user, session }
}
async function waitForLock(f: Pick<Awaited<ReturnType<typeof fixture>>, 'db'>) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const rows = await f.db.query(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth_users%'`,
    )
    if (rows.rows.length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Expected real PostgreSQL account-lock wait')
}
it('does not login through a candidate link removed while waiting for the account lock', async () => {
  const f = await setup()
  await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'Existing', email: 'old@example.com' }, f.user.id),
  )
  const proof = await f.ready(),
    entered = deferred(),
    release = deferred()
  const unlinkTransaction = f.db.transaction(async (tx) => {
    await tx.query('SELECT id FROM auth_users WHERE id=$1 FOR NO KEY UPDATE', [f.user.id])
    await tx.query('DELETE FROM auth_identity_links WHERE user_id=$1', [f.user.id])
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const login = f.registration.signIn(proof.context, proof.ticket, 'browser')
  const rejected = expect(login).rejects.toMatchObject({ code: 'IDENTITY_LINK_CONFLICT' })
  try {
    await waitForLock(f)
  } finally {
    release.resolve()
  }
  await unlinkTransaction
  await rejected
  expect((await f.db.query('SELECT * FROM auth_registration_grants')).rows).toHaveLength(0)
})
it('rejects a replaced link UUID even when the same provider subject is linked again', async () => {
  const f = await setup()
  const old = await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'Existing', email: 'old@example.com' }, f.user.id),
  )
  const proof = await f.ready(),
    entered = deferred(),
    release = deferred()
  const replacement = f.db.transaction(async (tx) => {
    await tx.query('SELECT id FROM auth_users WHERE id=$1 FOR NO KEY UPDATE', [f.user.id])
    await tx.query('DELETE FROM auth_identity_links WHERE user_id=$1', [f.user.id])
    const fresh = await f.links.createInside(
      tx,
      { id: '123', username: 'Existing', email: 'old@example.com' },
      f.user.id,
    )
    expect(fresh.id).not.toBe(old.id)
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const rejected = expect(
    f.registration.signIn(proof.context, proof.ticket, 'browser'),
  ).rejects.toMatchObject({ code: 'IDENTITY_LINK_CONFLICT' })
  try {
    await waitForLock(f)
  } finally {
    release.resolve()
  }
  await replacement
  await rejected
})
it('checks account disable after a real PostgreSQL lock wait before writing a consumed proof', async () => {
  const f = await setup(),
    proof = await f.ready(await f.links.begin(f.session, { clientIp: '127.0.0.1' })),
    entered = deferred(),
    release = deferred()
  const disable = f.db.transaction(async (tx) => {
    await tx.query('SELECT id FROM auth_users WHERE id=$1 FOR NO KEY UPDATE', [f.user.id])
    await tx.query('UPDATE auth_users SET disabled_at=$2 WHERE id=$1', [f.user.id, 1800000000000])
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const rejected = expect(
    f.links.link(f.session, proof.context, proof.attemptId, proof.ticket),
  ).rejects.toMatchObject({ code: 'SESSION_INVALID' })
  try {
    await waitForLock(f)
  } finally {
    release.resolve()
  }
  await disable
  await rejected
  expect((await f.db.query('SELECT * FROM auth_identity_links')).rows).toHaveLength(0)
})
it('holds per-account intent capacity and frees expired intent slots without evicting valid ones', async () => {
  const f = await setup()
  for (let i = 0; i < 3; i++) await f.links.begin(f.session, { clientIp: `127.0.0.${i + 1}` })
  await expect(f.links.begin(f.session, { clientIp: '127.0.0.9' })).rejects.toMatchObject({
    code: 'REGISTRATION_CAPACITY_EXCEEDED',
    retryAfterSeconds: 60,
  })
  f.advance(600_000)
  await expect(f.links.begin(f.session, { clientIp: '127.0.0.9' })).resolves.toHaveProperty('response')
})
it('limits global active intents to 256 across accounts before allocating another Cfx attempt', async () => {
  const f = await setup()
  for (let i = 0; i < 86; i++) {
    const { login } = await f.createUser(`user${i}@example.com`),
      session = await f.auth.authenticateToken(login.token)
    for (let j = 0; j < (i === 85 ? 1 : 3); j++)
      await f.links.begin(session, { clientIp: `10.0.${i}.${j + 1}` })
  }
  await expect(f.links.begin(f.session, { clientIp: '10.1.0.1' })).rejects.toMatchObject({
    code: 'REGISTRATION_CAPACITY_EXCEEDED',
  })
})
