import { afterEach, expect, it, vi } from 'vitest'
import { isolatedPostgres } from '@tests/helpers/postgres'
import { runMigrations } from '@server/src/db/migration-runner'
import { assertDatabaseReady } from '@server/src/db/schema-check'
import { Client } from 'pg'
import { openDatabase } from '@server/src/db/client'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Fixture = Awaited<ReturnType<typeof isolatedPostgres>>
const fixtures: Fixture[] = []
async function isolated(migrate = true) {
  const fixture = await isolatedPostgres({ migrate })
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

it('builds the current model from an empty PostgreSQL schema without legacy registration tables', async () => {
  const { db, schema } = await isolated()
  const { rows } = await db.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2 ORDER BY table_name',
    [schema, 'BASE TABLE'])
  const names = rows.map(row => row.table_name)
  expect(names).toEqual(expect.arrayContaining([
    'auth_users', 'auth_sessions', 'auth_sso_requests', 'community_groups', 'community_group_memberships',
    'join_applications', 'join_application_email_registry', 'join_application_forms', 'join_application_attachments',
    'join_invitations', 'join_email_controls', 'join_delivery_attempts',
  ]))
  expect(names).not.toEqual(expect.arrayContaining(['auth_registrations', 'auth_email_delivery']))
  expect((await db.query<{ code: string }>('SELECT code FROM community_groups ORDER BY code')).rows).toEqual([{ code: 'admin' }])
})

it('applies the real migration journal repeatedly without replacing application data', async () => {
  const { db, connectionString, schema } = await isolated()
  await db.query('INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ($1,$2,$3,$4,$5)',
    ['10000000-0000-4000-8000-000000000001', 'retained@example.com', 'Retained', 'hash', 100])
  const before = (await db.query('SELECT * FROM auth_users')).rows
  const journalBefore = (await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM "${schema}"."__drizzle_migrations"`)).rows[0]!.n
  await runMigrations({ connectionString, searchPath: schema, migrationsSchema: schema })
  expect((await db.query('SELECT * FROM auth_users')).rows).toEqual(before)
  expect((await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM "${schema}"."__drizzle_migrations"`)).rows[0]!.n).toBe(journalBefore)
})

it('rejects an incomplete baseline on explicit rerun and preserves its data', async () => {
  const { db, connectionString, schema } = await isolated()
  await db.query('INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ($1,$2,$3,$4,$5)',
    ['10000000-0000-4000-8000-000000000002', 'preserved@example.com', 'Preserved', 'hash', 100])
  await db.query('DROP INDEX join_invitations_active_application_unique')
  await expect(runMigrations({ connectionString, searchPath: schema, migrationsSchema: schema })).rejects.toThrow()
  expect((await db.query<{ email: string }>('SELECT email FROM auth_users')).rows).toEqual([{ email: 'preserved@example.com' }])
})

it('refuses the server startup readiness check on a partially migrated schema without repairing it', async () => {
  const { db, schema } = await isolated(false)
  await db.query('CREATE TABLE auth_users (id text PRIMARY KEY)')
  const objects = async () => (await db.query<{ relname: string }>(`
    SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f','i','I') ORDER BY c.relname`, [schema])).rows
  const before = await objects()
  expect(before.map(row => row.relname)).toContain('auth_users')
  expect(before.map(row => row.relname)).not.toContain('__drizzle_migrations')
  await expect(assertDatabaseReady(db, schema, schema)).rejects.toThrow('pnpm db:migrate')
  expect(await objects()).toEqual(before)
})

it('refuses real server startup on a partial baseline in an isolated container without writing', async () => {
  const { db, connectionString } = await isolated(false)
  const objects = async (schema: string) => (await db.query<{ relname: string }>(`
    SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f','i','I') ORDER BY c.relname`, [schema])).rows
  await db.query('CREATE TABLE public.auth_users (id text PRIMARY KEY)')
  try {
    const before = await Promise.all(['public', 'drizzle'].map(objects))
    expect(before[0]?.map(row => row.relname)).toContain('auth_users')
    expect(before[1]).toEqual([])
    const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url))
    const entry = fileURLToPath(new URL('../../apps/server/src/server.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(requireServer.resolve('tsx')).href, entry], {
      cwd: fileURLToPath(new URL('../../apps/server/', import.meta.url)),
      env: { ...process.env, DATABASE_URL: connectionString, AUTH_CODE_HMAC_KEY: 'a'.repeat(64) },
      encoding: 'utf8', timeout: 15_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('[server]')
    expect(await Promise.all(['public', 'drizzle'].map(objects))).toEqual(before)
  } finally { await db.query('DROP TABLE public.auth_users') }
}, 30_000)

it('keeps migration and runtime queries in the requested schema despite PGOPTIONS search_path', async () => {
  const { db, connectionString, schema } = await isolated(false)
  const otherSchema = `${schema}_other`
  await db.query(`CREATE SCHEMA "${otherSchema}"`)
  try {
    vi.stubEnv('PGOPTIONS', `-c search_path=${otherSchema}`)
    const plain = new Client({ connectionString })
    await plain.connect()
    try {
      expect((await plain.query<{ schema: string }>('SELECT current_schema() AS schema')).rows)
        .toEqual([{ schema: otherSchema }])
    } finally { await plain.end() }
    await runMigrations({ connectionString, searchPath: schema, migrationsSchema: schema })
    const runtime = await openDatabase({ connectionString, searchPath: schema })
    try {
      expect((await runtime.query<{ schema: string }>('SELECT current_schema() AS schema')).rows)
        .toEqual([{ schema }])
      await expect(assertDatabaseReady(runtime, schema, schema)).resolves.toBeUndefined()
      expect((await runtime.query<{ code: string }>('SELECT code FROM community_groups')).rows)
        .toEqual([{ code: 'admin' }])
    } finally { await runtime.close() }
    expect((await db.query<{ relname: string }>(`
      SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f','i','I')`, [otherSchema])).rows)
      .toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await db.query(`DROP SCHEMA "${otherSchema}" CASCADE`)
  }
})

it('enforces review state, registry references, and application form constraints in PostgreSQL', async () => {
  const { db } = await isolated()
  await db.query("INSERT INTO auth_users(id,email,nickname,password_hash,created_at) VALUES ('applicant','account@example.com','Applicant','hash',1)")
  const insert = (id: string, email: string, status = 'pending', reviewedAt: number | null = null) =>
    db.query("INSERT INTO join_applications (id,email,nickname,qq,status,created_at,reviewed_at,form_version,community_id,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'rifling-911','applicant')",
      [id, email, 'Applicant', '0001', status, 100, reviewedAt, 0])
  await insert('a', 'same@example.com')
  await expect(insert('b', 'same@example.com')).rejects.toMatchObject({ code: '23505' })
  await expect(insert('c', 'other@example.com', 'approved')).rejects.toMatchObject({ code: '23514' })
  await expect(db.query('INSERT INTO join_application_email_registry (email,canonical_application_id) VALUES ($1,$2)',
    ['different@example.com', 'a'])).rejects.toMatchObject({ code: '23503' })
  await expect(db.query('INSERT INTO join_application_forms (application_id,version,application_type,form_json) VALUES ($1,$2,$3,$4)',
    ['a', 2, 'new', '{}'])).rejects.toMatchObject({ code: '23514' })
})

it('stores attachment bytes and rejects a false length or digest shape', async () => {
  const { db } = await isolated()
  await db.query("INSERT INTO auth_users(id,email,nickname,password_hash,created_at) VALUES ('applicant','account@example.com','Applicant','hash',1)")
  await db.query("INSERT INTO join_applications (id,email,nickname,qq,status,created_at,community_id,user_id) VALUES ($1,$2,$3,$4,$5,$6,'rifling-911','applicant')",
    ['application', 'proof@example.com', 'Applicant', '0001', 'pending', 100])
  const insert = (id: string, byteLength: number, digest: string, bytes: Buffer) =>
    db.query('INSERT INTO join_application_attachments (id,application_id,ordinal,original_name,extension,sha256,byte_length,bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, 'application', 0, 'proof.png', 'png', digest, byteLength, bytes])
  const bytes = Buffer.from([0, 1, 255])
  await expect(insert('bad-length', 2, 'a'.repeat(64), bytes)).rejects.toMatchObject({ code: '23514' })
  await expect(insert('bad-digest', 3, 'not-a-digest', bytes)).rejects.toMatchObject({ code: '23514' })
  await insert('valid', 3, 'a'.repeat(64), bytes)
  expect((await db.query<{ bytes: Buffer }>('SELECT bytes FROM join_application_attachments WHERE id = $1', ['valid'])).rows[0]?.bytes)
    .toEqual(bytes)
})
