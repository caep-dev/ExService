import { afterEach, expect, it } from 'vitest'
import { isolatedPostgres } from '../helpers/postgres'
import { assertJoinSchemaAvailable } from '@server/src/domains/join/applications/schema-check'
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
})
it('requires current account ownership columns and indexes with read-only readiness checks', async () => {
  const f = await isolatedPostgres()
  closes.push(f.close)
  await expect(assertJoinSchemaAvailable(f.db)).resolves.toBeUndefined()
  await f.db.query('DROP INDEX join_applications_user_community_unique')
  await expect(assertJoinSchemaAvailable(f.db)).rejects.toThrow(
    'join_applications_user_community_unique',
  )
  expect(
    (
      await f.db.query(
        "SELECT * FROM pg_indexes WHERE schemaname=current_schema() AND indexname='join_applications_user_community_unique'",
      )
    ).rows,
  ).toEqual([])
})
it('refuses a missing ownership snapshot column without repairing the schema', async () => {
  const f = await isolatedPostgres()
  closes.push(f.close)
  await f.db.query('ALTER TABLE join_applications DROP COLUMN identity_snapshot_json')
  await expect(assertJoinSchemaAvailable(f.db)).rejects.toThrow('join_applications')
  expect(
    (
      await f.db.query(
        "SELECT * FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='join_applications' AND column_name='identity_snapshot_json'",
      )
    ).rows,
  ).toEqual([])
})
