import { expect, it, vi } from 'vitest'
import { joinActor, joinSnapshot } from '../helpers/auth'
import { setup } from './fixture'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
async function waiting(f: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(async () => {
    expect(
      (
        await f.db.query<{ n: number }>(
          "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM auth_users%'",
        )
      ).rows[0]!.n,
    ).toBeGreaterThan(0)
  })
}
it('holds actual approval locks until notice commit and makes reviewer revocation wait', async () => {
  const f = await setup(),
    admin = await joinActor(f, 'admin@example.com')
  await f.db.query(
    "INSERT INTO community_group_memberships(user_id,group_code) VALUES($1,'admin')",
    [admin.id],
  )
  await f.submit(f.input)
  const id = await f.id()
  const release = deferred(),
    entered = deferred(),
    original = f.notifications.producer.publishInside.bind(f.notifications.producer)
  const spy = vi
    .spyOn(f.notifications.producer, 'publishInside')
    .mockImplementation(async (...args) => {
      const result = await original(...args)
      entered.resolve()
      await release.promise
      return result
    })
  const decision = f.approve(id)
  await entered.promise
  const revoke = f.communityServices.revokeReviewer(admin.session, 'rifling-911', f.reviewer.id)
  try {
    await waiting(f)
  } finally {
    release.resolve()
    await decision
    await revoke
    spy.mockRestore()
  }
  expect((await f.db.query('SELECT * FROM community_memberships')).rows).toHaveLength(1)
  const before = await joinSnapshot(f)
  await expect(f.approve(id)).rejects.toMatchObject({
    code: 'COMMUNITY_REVIEW_FORBIDDEN',
  })
  expect(await joinSnapshot(f)).toEqual(before)
})
it('rechecks reviewer permission after waiting for a revocation transaction to commit', async () => {
  const f = await setup()
  await f.submit(f.input)
  const id = await f.id(),
    release = deferred(),
    entered = deferred()
  const revocation = f.db.transaction(async (tx) => {
    await f.communityServices.lockAccountsInside(tx, [f.reviewer.id])
    await tx.query('DELETE FROM community_reviewers WHERE user_id=$1', [f.reviewer.id])
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const decision = f.approve(id)
  const rejection = expect(decision).rejects.toMatchObject({
    code: 'COMMUNITY_REVIEW_FORBIDDEN',
  })
  try {
    await waiting(f)
  } finally {
    release.resolve()
    await revocation
  }
  await rejection
  expect((await f.get(id).catch((error) => error)).code).toBe('COMMUNITY_REVIEW_FORBIDDEN')
  expect((await f.db.query('SELECT status FROM join_applications')).rows).toEqual([
    { status: 'pending' },
  ])
  expect((await f.db.query('SELECT * FROM notification_events')).rows).toEqual([])
})
