import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { assertPublicRegistrationHistory } from './public-registration-inventory.js'
import { createVerifiedPool, type DatabaseOptions } from '@server/src/db/client.js'
import { APPLICATION_TABLES, BASELINE_APPLICATION_TABLES, NOTIFICATION_APPLICATION_TABLES, SUPPORT_APPLICATION_TABLES, assertDatabaseReady } from '@server/src/db/schema-check.js'

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
// Every complete historical table set remains a valid source for an upgrade.
// Matching names, rather than counts, still rejects incomplete/mixed versions.
const COMPLETE_TABLE_SETS = [
  BASELINE_APPLICATION_TABLES, // 0000
  [...BASELINE_APPLICATION_TABLES, 'auth_oidc_flows', 'auth_oidc_bindings', 'auth_identity_outbox'], // 0001
  NOTIFICATION_APPLICATION_TABLES, // 0002
  SUPPORT_APPLICATION_TABLES, // 0003 through 0005
  APPLICATION_TABLES, // 0006
]

export interface MigrationOptions extends DatabaseOptions { migrationsSchema?: string }

/** Explicit migration body shared by the CLI and isolated PostgreSQL tests. */
export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  const schema = options.searchPath ?? 'public'
  const migrationsSchema = options.migrationsSchema ?? 'drizzle'
  if (!SAFE_IDENTIFIER.test(schema) || !SAFE_IDENTIFIER.test(migrationsSchema)) throw new Error('无效的 migration schema。')
  if (schema !== 'public' && schema !== migrationsSchema) throw new Error('测试 migration journal 必须和隔离业务 schema 一致。')
  const pool = await createVerifiedPool(options)
  try {
    const objects = await pool.query<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f')`, [schema])
    const found = new Set(objects.rows.filter(row => row.relkind === 'r' || row.relkind === 'p').map(row => row.relname))
    const unknown = objects.rows.filter(row =>
      !APPLICATION_TABLES.includes(row.relname as typeof APPLICATION_TABLES[number]) &&
      !(schema === migrationsSchema && (row.relname === '__drizzle_migrations' ||
        (row.relkind === 'S' && row.relname === '__drizzle_migrations_id_seq'))))
    if (unknown.length) throw new Error('目标 schema 包含非本应用数据表；拒绝迁移。')
    const appTables = [...found].filter(table => APPLICATION_TABLES.includes(table as typeof APPLICATION_TABLES[number]))
    if (appTables.length !== 0 && !COMPLETE_TABLE_SETS.some(tables =>
      tables.length === appTables.length && tables.every(table => found.has(table)))) {
      throw new Error('Server schema 部分迁移；请人工核查，不自动修复。')
    }
    const journal = await pool.query(`SELECT 1 FROM pg_catalog.pg_tables
      WHERE schemaname = $1 AND tablename = '__drizzle_migrations'`, [migrationsSchema])
    if ((appTables.length === 0 && journal.rows.length !== 0) ||
        (appTables.length !== 0 && journal.rows.length !== 1)) {
      throw new Error('Server schema 与 migration 记录不一致；请人工核查，不自动修复。')
    }
    if (migrationsSchema !== schema) {
      const journalObjects = await pool.query<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f')`, [migrationsSchema])
      if (journalObjects.rows.some(row => row.relname !== '__drizzle_migrations' &&
          !(row.relkind === 'S' && row.relname === '__drizzle_migrations_id_seq'))) {
        throw new Error('migration schema 含非本应用对象；拒绝迁移。')
      }
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${migrationsSchema}"`)
      await client.query(`CREATE TABLE IF NOT EXISTS "${migrationsSchema}".__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`)
      await client.query(`LOCK TABLE "${migrationsSchema}".__drizzle_migrations IN ACCESS EXCLUSIVE MODE`)
      const applied = await client.query<{ hash: string; created_at: string }>(`SELECT hash,created_at FROM "${migrationsSchema}".__drizzle_migrations ORDER BY created_at`)
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
      if (applied.rows.length > migrations.length || applied.rows.some((row, index) => row.hash !== migrations[index]?.hash || Number(row.created_at) !== migrations[index]?.folderMillis)) throw new Error('Server migration journal mismatch; refusing upgrade.')
      for (const [index, migration] of migrations.entries()) {
        if (index < applied.rows.length) continue
        if (index === 6) {
          // Freeze all source facts before checking, then validate and write using
          // this same connection and transaction. Inventory cannot authorize writes.
          for (const table of SUPPORT_APPLICATION_TABLES) await client.query(`LOCK TABLE "${table}" IN SHARE ROW EXCLUSIVE MODE`)
          await assertPublicRegistrationHistory(client)
        }
        for (const statement of migration.sql) await client.query(statement)
        await client.query(`INSERT INTO "${migrationsSchema}".__drizzle_migrations(hash,created_at) VALUES ($1,$2)`, [migration.hash, migration.folderMillis])
      }
      await assertDatabaseReady(client, schema, migrationsSchema)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  } finally { await pool.end() }
}
