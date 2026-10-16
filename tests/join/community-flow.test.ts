import { afterEach, expect, it } from 'vitest'
import { fixture } from '../registration/fixture'
import { CommunityService } from '@server/src/modules/communities/service'
import { createNotificationModule } from '@server/src/modules/notifications/factory'
import { JoinService } from '@server/src/domains/join/applications/service'
import { newJoinApplication } from '../helpers/auth'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
export async function joinFixture() {
  const f = await fixture()
  cleanup.push(() => f.close())
  const communities = new CommunityService({
    db: f.db,
    authServices: f.auth,
    identityLinkServices: f.links,
    now: f.deps.now,
  })
  const notifications = createNotificationModule({
    db: f.db,
    tokenKey: Buffer.alloc(32, 3),
    now: f.deps.now,
  })
  const deps = {
    db: f.db,
    authServices: f.auth,
    communityServices: communities,
    identityLinkServices: f.links,
    notifications,
    now: f.deps.now,
  }
  const join = new JoinService(deps)
  const a = await f.user('applicant@example.com'),
    r = await f.user('reviewer@example.com')
  const applicant = await f.auth.authenticateToken(a.login.token),
    reviewer = await f.auth.authenticateToken(r.login.token)
  await f.db.query(
    'INSERT INTO community_reviewers(community_id,user_id,granted_by_user_id,granted_at) VALUES($1,$2,$2,$3)',
    ['rifling-911', r.user.id, f.deps.now()],
  )
  await f.db.transaction((tx) =>
    f.links.createInside(
      tx,
      { id: '123', username: 'External', email: 'cfx@example.com' },
      a.user.id,
    ),
  )
  const input = newJoinApplication()
  return {
    ...f,
    communities,
    notifications,
    join,
    deps,
    applicant,
    reviewer,
    input,
    async id() {
      return (
        await f.db.query<{ id: string }>('SELECT id FROM join_applications ORDER BY created_at,id')
      ).rows[0]!.id
    },
  }
}
it('stores UUID-owned snapshots, rejects lifetime duplicates and allows the same account in another community', async () => {
  const f = await joinFixture()
  expect(await f.join.submit(f.applicant, 'rifling-911', f.input)).toEqual({
    status: 'received',
  })
  const id = await f.id(),
    detail = await f.join.get(f.reviewer, 'rifling-911', id)
  expect(detail.application).toMatchObject({
    applicantUserId: f.applicant.userId,
    email: 'applicant@example.com',
    nickname: 'Owner',
    legacyReadOnly: false,
    identitySnapshot: { externalUserId: '123' },
  })
  await f.join.reject(f.reviewer, 'rifling-911', id)
  await expect(f.join.submit(f.applicant, 'rifling-911', f.input)).rejects.toMatchObject({
    code: 'JOIN_APPLICATION_EXISTS',
  })
  await f.db.query(
    "INSERT INTO communities(id,display_name,requires_cfx,created_at,updated_at) VALUES('second','Second',false,$1,$1)",
    [f.deps.now()],
  )
  await expect(f.join.submit(f.applicant, 'second', f.input)).resolves.toEqual({
    status: 'received',
  })
  expect((await f.db.query('SELECT * FROM join_application_email_registry')).rows).toHaveLength(0)
})
it('atomically approves membership and one notice, preserving it after unlink and same-decision replay', async () => {
  const f = await joinFixture()
  await f.join.submit(f.applicant, 'rifling-911', f.input)
  const id = await f.id()
  await f.links.unlink(f.applicant)
  const result = await f.join.approve(f.reviewer, 'rifling-911', id)
  expect(result.application).toMatchObject({
    status: 'approved',
    reviewedByUserId: f.reviewer.userId,
    missingProviders: ['cfx'],
  })
  expect((await f.db.query('SELECT * FROM community_memberships')).rows).toHaveLength(1)
  expect((await f.db.query('SELECT event_type FROM notification_events')).rows).toEqual([
    { event_type: 'join.application.approved' },
  ])
  await f.db.query("UPDATE communities SET display_name='Renamed' WHERE id='rifling-911'")
  await f.join.approve(f.reviewer, 'rifling-911', id)
  expect((await f.db.query('SELECT * FROM notification_events')).rows).toHaveLength(1)
  await expect(f.join.reject(f.reviewer, 'rifling-911', id)).rejects.toMatchObject({
    code: 'JOIN_STATE_CONFLICT',
  })
  expect((await f.communities.myStatus(f.applicant, 'rifling-911')).websiteReady).toBe(false)
  expect((await f.db.query('SELECT * FROM join_invitations')).rows).toHaveLength(0)
})
it('rejects unauthorized review and cross-community IDs before exposing details', async () => {
  const f = await joinFixture()
  await f.join.submit(f.applicant, 'rifling-911', f.input)
  const id = await f.id()
  await expect(f.join.get(f.applicant, 'rifling-911', id)).rejects.toMatchObject({
    code: 'COMMUNITY_REVIEW_FORBIDDEN',
  })
  await expect(f.join.list(f.applicant, 'rifling-911')).rejects.toMatchObject({
    code: 'COMMUNITY_REVIEW_FORBIDDEN',
  })
  await f.db.query(
    "INSERT INTO communities(id,display_name,requires_cfx,created_at,updated_at) VALUES('second','Second',false,$1,$1)",
    [f.deps.now()],
  )
  await f.db.query(
    "INSERT INTO community_reviewers(community_id,user_id,granted_by_user_id,granted_at) VALUES('second',$1,$1,$2)",
    [f.reviewer.userId, f.deps.now()],
  )
  await expect(f.join.get(f.reviewer, 'second', id)).rejects.toMatchObject({
    code: 'JOIN_APPLICATION_NOT_FOUND',
  })
})
it('rolls application and membership back when real notification persistence fails', async () => {
  const f = await joinFixture()
  await f.join.submit(f.applicant, 'rifling-911', f.input)
  const id = await f.id()
  await f.db.query(
    `CREATE FUNCTION deny_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected persistence failure'; END $$`,
  )
  await f.db.query(
    'CREATE TRIGGER fail_notice BEFORE INSERT ON notification_events FOR EACH ROW EXECUTE FUNCTION deny_notice()',
  )
  await expect(f.join.approve(f.reviewer, 'rifling-911', id)).rejects.toThrow()
  expect((await f.db.query('SELECT status,reviewed_at FROM join_applications')).rows).toEqual([
    { status: 'pending', reviewed_at: null },
  ])
  expect((await f.db.query('SELECT * FROM community_memberships')).rows).toHaveLength(0)
  expect((await f.db.query('SELECT * FROM notification_contents')).rows).toHaveLength(0)
})

it('does not use external subject or contact snapshots as lifetime ownership keys', async () => {
  const f = await joinFixture()
  await f.join.submit(f.applicant, 'rifling-911', f.input)
  await f.links.unlink(f.applicant)
  const next = await f.user('second-owner@example.com'),
    session = await f.auth.authenticateToken(next.login.token)
  await f.db.transaction((tx) =>
    f.links.createInside(
      tx,
      { id: '123', username: 'External', email: 'cfx@example.com' },
      session.userId,
    ),
  )
  await expect(f.join.submit(session, 'rifling-911', f.input)).resolves.toEqual({
    status: 'received',
  })
  expect((await f.db.query('SELECT * FROM join_applications')).rows).toHaveLength(2)
  await f.db.query('UPDATE auth_users SET email=$1,nickname=$2 WHERE id=$3', [
    'renamed@example.com',
    'Renamed',
    f.applicant.userId,
  ])
  await expect(f.join.submit(f.applicant, 'rifling-911', f.input)).rejects.toMatchObject({
    code: 'JOIN_APPLICATION_EXISTS',
  })
  const rows = (
    await f.db.query('SELECT email,nickname FROM join_applications WHERE user_id=$1', [
      f.applicant.userId,
    ])
  ).rows
  expect(rows).toEqual([{ email: 'applicant@example.com', nickname: 'Owner' }])
})
