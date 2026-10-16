import { expect, it } from 'vitest'
import { openDatabase } from '@server/src/db/client'
import { JoinService } from '@server/src/domains/join/applications/service'
import { setup } from './fixture'
it('arbitrates one lifetime UUID/community application across independent PostgreSQL pools', async () => {
  const f = await setup(),
    db = await openDatabase({
      connectionString: f.connectionString,
      searchPath: f.schema,
    })
  try {
    const other = new JoinService({ ...f.deps, db }),
      results = await Promise.allSettled([
        f.submit(f.input),
        other.submit(f.applicant.session, 'rifling-911', f.input),
      ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'JOIN_APPLICATION_EXISTS' },
    })
    for (const table of ['join_applications', 'join_application_forms'])
      expect((await f.db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1)
    expect((await f.db.query('SELECT * FROM join_application_email_registry')).rows).toEqual([])
  } finally {
    await db.close()
  }
})
it('serializes same and opposite review decisions across independent pools without duplicate notices', async () => {
  const f = await setup(),
    db = await openDatabase({
      connectionString: f.connectionString,
      searchPath: f.schema,
    })
  try {
    const other = new JoinService({ ...f.deps, db })
    await f.submit(f.input)
    const id = await f.id()
    const results = await Promise.allSettled([
      f.approve(id),
      other.reject(f.reviewer.session, 'rifling-911', id),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'JOIN_STATE_CONFLICT' },
    })
    const current = await f.get(id)
    await Promise.all(
      [f.joinServices, other].map((service) =>
        current.application.status === 'approved'
          ? service.approve(f.reviewer.session, 'rifling-911', id)
          : service.reject(f.reviewer.session, 'rifling-911', id),
      ),
    )
    expect((await f.db.query('SELECT * FROM notification_events')).rows).toHaveLength(1)
    expect((await f.db.query('SELECT * FROM community_memberships')).rows).toHaveLength(
      current.application.status === 'approved' ? 1 : 0,
    )
  } finally {
    await db.close()
  }
})
