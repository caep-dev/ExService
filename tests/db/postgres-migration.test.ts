import { afterEach, expect, it } from 'vitest'
import { runMigrations } from '@server/src/db/migration-runner'
import { openDatabase } from '@server/src/db/client'
import { resetDatabase } from '@server/src/db/reset-plan'
import { isolatedPostgres } from '@tests/helpers/postgres'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const resources: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(resources.splice(0).map(resource => resource.close())) })

async function installMigrationPrefix(isolated: Awaited<ReturnType<typeof isolatedPostgres>>, count: number) {
  const folder = new URL('../../apps/server/drizzle/', import.meta.url)
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as {
    entries: Array<{ tag: string; when: number }>
  }
  await isolated.db.transaction(async tx => {
    await tx.query('CREATE TABLE __drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)')
    for (const migration of journal.entries.slice(0, count)) {
      const source = readFileSync(new URL(`${migration.tag}.sql`, folder), 'utf8')
      for (const sql of source.split('--> statement-breakpoint')) await tx.query(sql)
      await tx.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [createHash('sha256').update(source).digest('hex'), migration.when])
    }
  })
}

it.each([1, 2, 3, 4, 5, 6])('upgrades the complete %i-migration historical schema without replacing data', async count => {
  const isolated = await isolatedPostgres({ migrate: false })
  resources.push(isolated)
  await installMigrationPrefix(isolated, count)
  await isolated.db.query("INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ('retained','retained@example.com','Retained','hash',1)")
  const before = (await isolated.db.query('SELECT id,email,nickname,password_hash,created_at FROM auth_users')).rows
  await runMigrations({ connectionString: isolated.connectionString, searchPath: isolated.schema, migrationsSchema: isolated.schema })
  expect((await isolated.db.query('SELECT id,email,nickname,password_hash,created_at FROM auth_users')).rows).toEqual(before)
  expect((await isolated.db.query('SELECT count(*)::integer AS n FROM notification_receipts')).rows).toEqual([{ n: 0 }])
  const migrationCount = JSON.parse(readFileSync(new URL('../../apps/server/drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries.length as number
  expect((await isolated.db.query('SELECT count(*)::integer AS n FROM __drizzle_migrations')).rows).toEqual([{ n: migrationCount }])
  expect((await isolated.db.query('SELECT count(*)::integer AS n FROM support_feedback_submissions')).rows).toEqual([{ n: 0 }])
  expect((await isolated.db.query('SELECT count(*)::integer AS n FROM communities')).rows).toEqual([{ n: 1 }])
})

it('refuses a historical schema with a substituted table before applying pending migrations', async () => {
  const isolated = await isolatedPostgres({ migrate: false })
  resources.push(isolated)
  await installMigrationPrefix(isolated, 2)
  await isolated.db.query('DROP TABLE auth_identity_outbox')
  await isolated.db.query('CREATE TABLE notification_contents (content_id text PRIMARY KEY)')
  const before = (await isolated.db.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows
  await expect(runMigrations({ connectionString: isolated.connectionString, searchPath: isolated.schema, migrationsSchema: isolated.schema }))
    .rejects.toThrow('部分迁移')
  expect((await isolated.db.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows).toEqual(before)
  expect((await isolated.db.query("SELECT to_regclass('notification_receipts') AS name")).rows).toEqual([{ name: null }])
})

it('migrates an empty isolated exre schema and leaves its baseline intact on rerun', async () => {
  const isolated = await isolatedPostgres({ migrate: false })
  resources.push(isolated)
  const options = { connectionString: isolated.connectionString, searchPath: isolated.schema, migrationsSchema: isolated.schema }
  await runMigrations(options)
  const before = await isolated.db.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [isolated.schema])
  expect(before.rows.map(row => row.table_name)).toEqual(expect.arrayContaining([
    'auth_users', 'auth_sessions', 'auth_sso_requests', 'join_applications', 'join_application_email_registry',
    'join_application_forms', 'join_application_attachments', 'join_invitations', 'join_delivery_attempts',
    'join_email_controls', 'community_groups', 'community_group_memberships',
  ]))
  expect((await isolated.db.query<{ code: string }>('SELECT code FROM community_groups')).rows).toEqual([{ code: 'admin' }])
  await runMigrations(options)
  const after = await isolated.db.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [isolated.schema])
  expect(after.rows).toEqual(before.rows)
})

it('rejects outline as target before opening or migrating it', async () => {
  const wrongTarget = 'postgres://example:example@127.0.0.1:1/outline'
  await expect(openDatabase({ connectionString: wrongTarget })).rejects.toThrow()
  await expect(runMigrations({ connectionString: wrongTarget })).rejects.toThrow()
  await expect(resetDatabase({ connectionString: wrongTarget }, 'exre')).rejects.toThrow()
})

it('refuses reset without explicit confirmation or when unknown data exists', async () => {
  const isolated = await isolatedPostgres()
  resources.push(isolated)
  const options = { connectionString: isolated.connectionString, searchPath: isolated.schema }
  await isolated.db.query("INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ('user-1','member@example.com','Member','hash',1)")
  await expect(resetDatabase(options, '')).rejects.toThrow()
  expect((await isolated.db.query<{ n: number }>('SELECT count(*) n FROM auth_users')).rows[0]).toEqual({ n: 1 })
  await isolated.db.query('CREATE TABLE foreign_data (id int)')
  await expect(resetDatabase(options, 'exre')).rejects.toThrow()
  expect((await isolated.db.query<{ n: number }>('SELECT count(*) n FROM auth_users')).rows[0]).toEqual({ n: 1 })
})

it('resets only its isolated schema and reapplies the baseline', async () => {
  const isolated = await isolatedPostgres()
  resources.push(isolated)
  const options = { connectionString: isolated.connectionString, searchPath: isolated.schema }
  await isolated.db.query("INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ('user-1','member@example.com','Member','hash',1)")
  await resetDatabase(options, 'exre')
  expect((await isolated.db.query<{ n: number }>('SELECT count(*) n FROM auth_users')).rows[0]).toEqual({ n: 0 })
  expect((await isolated.db.query<{ code: string }>('SELECT code FROM community_groups')).rows).toEqual([{ code: 'admin' }])
})

it('refuses reset when the separate migration schema contains an unknown function without changing data or journal', async () => {
  const isolated = await isolatedPostgres({ migrate: false })
  resources.push(isolated)
  const { db, connectionString } = isolated
  try {
    await runMigrations({ connectionString })
    await db.query(`INSERT INTO public.auth_users (id,email,nickname,password_hash,created_at)
      VALUES ('user-1','member@example.com','Member','hash',1)`)
    await db.query('CREATE FUNCTION drizzle.foreign_reset_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
    const snapshot = async () => {
      const [objects, functions, users, journal] = await Promise.all([
        db.query(`SELECT n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','S','f','i','I')
          ORDER BY n.nspname,c.relname`),
        db.query(`SELECT n.nspname,p.proname FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname,p.proname`),
        db.query('SELECT * FROM public.auth_users ORDER BY id'),
        db.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id'),
      ])
      return { objects: objects.rows, functions: functions.rows, users: users.rows, journal: journal.rows }
    }
    const before = await snapshot()
    expect(before.functions).toContainEqual({ nspname: 'drizzle', proname: 'foreign_reset_probe' })
    await expect(resetDatabase({ connectionString }, 'exre')).rejects.toThrow('migration schema')
    expect(await snapshot()).toEqual(before)
  } finally {
    await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await db.query('DROP SCHEMA public CASCADE')
    await db.query('CREATE SCHEMA public')
  }
})

it.each([
  'trigger', 'check', 'rule', 'policy', 'statistics', 'publication',
  'new_default', 'changed_default', 'same_name_unique', 'same_name_check', 'same_name_index',
  'invalid_index',
] as const)(
  'refuses reset when a business table has an unknown %s without changing data or journal',
  async kind => {
    const isolated = await isolatedPostgres({ migrate: false })
    resources.push(isolated)
    const { db, connectionString } = isolated
    try {
      await runMigrations({ connectionString })
      await db.query(`INSERT INTO public.auth_users (id,email,nickname,password_hash,created_at)
        VALUES ('user-1','member@example.com','Member','hash',1)`)
      if (kind === 'trigger') {
        // Keep the trigger function outside both reset target schemas so pg_proc checks cannot mask this regression.
        await db.query('CREATE SCHEMA trigger_helper')
        await db.query(`CREATE FUNCTION trigger_helper.pass_through() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RETURN NEW; END $$`)
        await db.query(`CREATE TRIGGER foreign_user_insert BEFORE INSERT ON public.auth_users
          FOR EACH ROW EXECUTE FUNCTION trigger_helper.pass_through()`)
      } else if (kind === 'check') {
        await db.query(`ALTER TABLE public.auth_users ADD CONSTRAINT foreign_nickname_check
          CHECK (length(nickname) > 0)`)
      } else if (kind === 'rule') {
        await db.query('CREATE RULE foreign_user_delete AS ON DELETE TO public.auth_users DO ALSO NOTHING')
      } else if (kind === 'policy') {
        await db.query('CREATE POLICY foreign_user_select ON public.auth_users FOR SELECT USING (true)')
      } else if (kind === 'statistics') {
        await db.query('CREATE STATISTICS foreign_user_stats (dependencies) ON email, nickname FROM public.auth_users')
      } else if (kind === 'publication') {
        await db.query('CREATE PUBLICATION foreign_user_pub FOR TABLE public.auth_users')
      } else if (kind === 'new_default') {
        await db.query("ALTER TABLE public.auth_users ALTER COLUMN nickname SET DEFAULT 'unexpected'")
      } else if (kind === 'changed_default') {
        await db.query('ALTER TABLE public.join_applications ALTER COLUMN form_version SET DEFAULT 1')
      } else if (kind === 'same_name_unique') {
        await db.query('ALTER TABLE public.auth_users DROP CONSTRAINT auth_users_email_unique')
        await db.query('ALTER TABLE public.auth_users ADD CONSTRAINT auth_users_email_unique UNIQUE (nickname)')
      } else if (kind === 'same_name_check') {
        await db.query('ALTER TABLE public.join_applications DROP CONSTRAINT join_applications_review_check')
        await db.query('ALTER TABLE public.join_applications ADD CONSTRAINT join_applications_review_check CHECK (true)')
      } else if (kind === 'same_name_index') {
        await db.query('DROP INDEX public.join_applications_email_history_idx')
        await db.query('CREATE INDEX join_applications_email_history_idx ON public.join_applications (nickname)')
      } else {
        await db.query('DROP INDEX public.auth_users_avatar_key_unique')
        await db.query("UPDATE public.auth_users SET avatar_key = 'shared-avatar' WHERE id = 'user-1'")
        await db.query(`INSERT INTO public.auth_users (id,email,nickname,password_hash,created_at,avatar_key)
          VALUES ('user-2','two@example.com','Two','hash',2,'shared-avatar')`)
        await expect(db.query(`CREATE UNIQUE INDEX CONCURRENTLY auth_users_avatar_key_unique
          ON public.auth_users (avatar_key)`)).rejects.toMatchObject({ code: '23505' })
      }
      const snapshot = async () => {
        const [objects, triggers, constraints, indexes, indexStates, rules, policies, statistics, publications, defaults, users, journal] = await Promise.all([
          db.query(`SELECT n.nspname,c.relname,c.relkind FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','S','f','i','I')
            ORDER BY n.nspname,c.relname`),
          db.query(`SELECT t.tgname,c.relname AS table_name FROM pg_catalog.pg_trigger t
            JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY t.tgname`),
          db.query(`SELECT c.conname,t.relname AS table_name,pg_catalog.pg_get_constraintdef(c.oid) AS definition
            FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' ORDER BY c.conname`),
          db.query(`SELECT tablename,indexname,indexdef FROM pg_catalog.pg_indexes
            WHERE schemaname = 'public' ORDER BY tablename,indexname`),
          db.query(`SELECT t.relname AS table_name,c.relname AS index_name,
              i.indisvalid,i.indisready,i.indislive
            FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
            JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' ORDER BY t.relname,c.relname`),
          db.query(`SELECT schemaname,tablename,rulename,definition FROM pg_catalog.pg_rules
            WHERE schemaname = 'public' ORDER BY tablename,rulename`),
          db.query(`SELECT schemaname,tablename,policyname,cmd,qual FROM pg_catalog.pg_policies
            WHERE schemaname = 'public' ORDER BY tablename,policyname`),
          db.query(`SELECT s.stxname,t.relname AS table_name FROM pg_catalog.pg_statistic_ext s
            JOIN pg_catalog.pg_class t ON t.oid = s.stxrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' ORDER BY s.stxname`),
          db.query(`SELECT p.pubname,t.relname AS table_name FROM pg_catalog.pg_publication_rel r
            JOIN pg_catalog.pg_publication p ON p.oid = r.prpubid
            JOIN pg_catalog.pg_class t ON t.oid = r.prrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' ORDER BY p.pubname,t.relname`),
          db.query(`SELECT t.relname AS table_name,a.attname AS column_name,
              pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression
            FROM pg_catalog.pg_attrdef d
            JOIN pg_catalog.pg_class t ON t.oid = d.adrelid
            JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' ORDER BY t.relname,a.attname`),
          db.query('SELECT * FROM public.auth_users ORDER BY id'),
          db.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id'),
        ])
        return {
          objects: objects.rows, triggers: triggers.rows, constraints: constraints.rows, indexes: indexes.rows,
          indexStates: indexStates.rows,
          rules: rules.rows, policies: policies.rows, statistics: statistics.rows, publications: publications.rows,
          defaults: defaults.rows,
          users: users.rows, journal: journal.rows,
        }
      }
      const before = await snapshot()
      if (kind === 'trigger') {
        expect(before.triggers).toContainEqual({ tgname: 'foreign_user_insert', table_name: 'auth_users' })
      } else if (kind === 'check') {
        expect(before.constraints).toContainEqual(expect.objectContaining({
          conname: 'foreign_nickname_check', table_name: 'auth_users',
        }))
      } else if (kind === 'rule') {
        expect(before.rules).toEqual([expect.objectContaining({ tablename: 'auth_users', rulename: 'foreign_user_delete' })])
      } else if (kind === 'policy') {
        expect(before.policies).toEqual([expect.objectContaining({ tablename: 'auth_users', policyname: 'foreign_user_select' })])
      } else if (kind === 'statistics') {
        expect(before.statistics).toEqual([{ stxname: 'foreign_user_stats', table_name: 'auth_users' }])
      } else if (kind === 'publication') {
        expect(before.publications).toEqual([{ pubname: 'foreign_user_pub', table_name: 'auth_users' }])
      } else if (kind === 'new_default') {
        expect(before.defaults).toContainEqual({
          table_name: 'auth_users', column_name: 'nickname', expression: "'unexpected'::text",
        })
      } else if (kind === 'changed_default') {
        expect(before.defaults).toContainEqual({
          table_name: 'join_applications', column_name: 'form_version', expression: '1',
        })
      } else if (kind === 'same_name_unique') {
        expect(before.constraints).toContainEqual(expect.objectContaining({
          conname: 'auth_users_email_unique', table_name: 'auth_users', definition: 'UNIQUE (nickname)',
        }))
      } else if (kind === 'same_name_check') {
        expect(before.constraints).toContainEqual(expect.objectContaining({
          conname: 'join_applications_review_check', table_name: 'join_applications', definition: 'CHECK (true)',
        }))
      } else if (kind === 'same_name_index') {
        expect(before.indexes).toContainEqual(expect.objectContaining({
          tablename: 'join_applications', indexname: 'join_applications_email_history_idx',
          indexdef: expect.stringContaining('(nickname)'),
        }))
      } else {
        expect(before.indexStates).toContainEqual(expect.objectContaining({
          table_name: 'auth_users', index_name: 'auth_users_avatar_key_unique', indisvalid: false,
        }))
      }
      await expect(resetDatabase({ connectionString }, 'exre')).rejects.toThrow()
      expect(await snapshot()).toEqual(before)
    } finally {
      await db.query('DROP PUBLICATION IF EXISTS foreign_user_pub')
      await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
      await db.query('DROP SCHEMA public CASCADE')
      await db.query('DROP SCHEMA IF EXISTS trigger_helper CASCADE')
      await db.query('CREATE SCHEMA public')
    }
  },
)

it('locks target tables before reset preflight so queued DDL cannot enter between inspection and DROP', async () => {
  const isolated = await isolatedPostgres({ migrate: false })
  resources.push(isolated)
  const { db, connectionString } = isolated
  const holder = new Client({ connectionString })
  const ddl = new Client({ connectionString })
  const observer = new Client({ connectionString })
  let resetResult: Promise<{ ok: boolean; error?: unknown }> | undefined
  let ddlResult: Promise<{ ok: boolean; error?: unknown }> | undefined
  const waitingCount = async () => {
    const result = await observer.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_catalog.pg_locks
      WHERE relation = 'public.auth_users'::regclass AND NOT granted`)
    return Number(result.rows[0]!.n)
  }
  const waitForWaiters = async (count: number) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await waitingCount() >= count) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Expected ${count} blocked auth_users table lock requests`)
  }
  try {
    await runMigrations({ connectionString })
    await db.query(`INSERT INTO public.auth_users (id,email,nickname,password_hash,created_at)
      VALUES ('user-1','member@example.com','Member','hash',1)`)
    const beforeUsers = (await db.query('SELECT * FROM public.auth_users ORDER BY id')).rows
    const beforeJournal = (await db.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    await Promise.all([holder.connect(), ddl.connect(), observer.connect()])
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.auth_users IN ACCESS SHARE MODE')
    ddlResult = ddl.query('CREATE RULE foreign_race_rule AS ON DELETE TO public.auth_users DO ALSO NOTHING')
      .then(() => ({ ok: true }), error => ({ ok: false, error }))
    await waitForWaiters(1)
    resetResult = resetDatabase({ connectionString }, 'exre')
      .then(() => ({ ok: true }), error => ({ ok: false, error }))
    await waitForWaiters(2)
    await holder.query('COMMIT')
    expect(await ddlResult).toMatchObject({ ok: true })
    expect(await resetResult).toMatchObject({ ok: false })
    expect((await db.query('SELECT * FROM public.auth_users ORDER BY id')).rows).toEqual(beforeUsers)
    expect((await db.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(beforeJournal)
    expect((await db.query<{ rulename: string }>(`SELECT rulename FROM pg_catalog.pg_rules
      WHERE schemaname = 'public' AND tablename = 'auth_users' AND rulename = 'foreign_race_rule'`)).rows)
      .toEqual([{ rulename: 'foreign_race_rule' }])
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined)
    await Promise.allSettled([ddlResult, resetResult])
    await Promise.all([holder.end(), ddl.end(), observer.end()])
    await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await db.query('DROP SCHEMA public CASCADE')
    await db.query('CREATE SCHEMA public')
  }
}, 90_000)
