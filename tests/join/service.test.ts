import { expect, it } from 'vitest'
import { JoinRateLimiter } from '@server/src/domains/join/applications/rate-limiter'
import { setup } from './fixture'
it('requires current Cfx at submit and leaves all application storage untouched on rejection', async () => {
  const f = await setup()
  await f.identityLinkServices.unlink(f.applicant.session)
  await expect(f.submit(f.input)).rejects.toMatchObject({
    code: 'COMMUNITY_REQUIREMENT_UNMET',
  })
  for (const table of [
    'join_applications',
    'join_application_forms',
    'join_application_attachments',
  ])
    expect((await f.db.query(`SELECT * FROM ${table}`)).rows).toEqual([])
})
it('rejects expired, logged-out and disabled applicant sessions at the transaction boundary', async () => {
  const f = await setup()
  await f.authServices.logout(f.applicant.session)
  await expect(f.submit(f.input)).rejects.toMatchObject({
    code: 'SESSION_INVALID',
  })
  const login = await f.authServices.login({
    email: 'applicant@example.com',
    password: 'valid password',
  })
  const session = await f.authServices.authenticateToken(login.token)
  await f.db.query('UPDATE auth_users SET disabled_at=$1 WHERE id=$2', [f.now(), session.userId])
  await expect(f.joinServices.submit(session, 'rifling-911', f.input)).rejects.toMatchObject({
    code: 'SESSION_INVALID',
  })
})
it('allows a disabled applicant to receive a terminal result while requiring a live reviewer', async () => {
  const f = await setup()
  await f.submit(f.input)
  const id = await f.id()
  await f.db.query('UPDATE auth_users SET disabled_at=$1 WHERE id=$2', [f.now(), f.applicant.id])
  expect((await f.reject(id)).application.status).toBe('rejected')
  expect((await f.db.query('SELECT user_id FROM notification_event_recipients')).rows).toEqual([
    { user_id: f.applicant.id },
  ])
  await f.db.query('UPDATE auth_users SET disabled_at=$1 WHERE id=$2', [f.now(), f.reviewer.id])
  await expect(f.reject(id)).rejects.toMatchObject({ code: 'SESSION_INVALID' })
})
it('uses a bounded expiring IP limiter', () => {
  let now = 0
  const limiter = new JoinRateLimiter(() => now)
  for (let i = 0; i < 60; i++) expect(limiter.check('ip')).toBeUndefined()
  expect(limiter.check('ip')).toBe(60)
  for (let i = 0; i < 1024; i++) limiter.check(`other-${i}`)
  expect(limiter.check('ip')).toBeUndefined()
  now = 60_000
  expect(limiter.check('ip')).toBeUndefined()
})
