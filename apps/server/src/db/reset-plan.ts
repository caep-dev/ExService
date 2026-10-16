import { createVerifiedPool, assertDatabaseUrl, type DatabaseOptions } from '@server/src/db/client.js'
import { runMigrations } from '@server/src/db/migration-runner.js'
import {
  APPLICATION_TABLES, APPLICATION_CONSTRAINT_DEFINITIONS, APPLICATION_INDEX_SIGNATURES, indexSignature,
} from '@server/src/db/schema-check.js'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import * as schemaTables from '@server/src/db/schema.js'

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const DROP_ORDER = [
  'support_feedback_attachments', 'support_feedback_submissions',
  'community_memberships', 'community_reviewers', 'auth_registration_deliveries',
  'auth_registration_grants', 'auth_registration_emails', 'auth_identity_links',
  'notification_clear_batch_items', 'notification_clear_batches', 'notification_mutations',
  'notification_preferences', 'notification_receipts', 'notification_user_streams',
  'notification_event_recipients', 'notification_events', 'notification_contents',
  'auth_identity_outbox', 'auth_oidc_bindings', 'auth_oidc_flows',
  'join_delivery_attempts', 'join_email_controls', 'join_invitations',
  'join_application_attachments', 'join_application_forms', 'join_application_email_registry',
  'join_applications', 'community_group_memberships', 'auth_sso_requests',
  'auth_sessions', 'community_groups', 'communities', 'auth_users',
] as const
const APPLICATION_INDEXES = new Set([...APPLICATION_INDEX_SIGNATURES.keys()].map(name => name.split('.')[1]))
const BASELINE_NOT_NULL_COLUMNS = new Set([
  schemaTables.authIdentityLinks, schemaTables.authRegistrationEmails, schemaTables.authRegistrationDeliveries,
  schemaTables.authRegistrationGrants, schemaTables.communities, schemaTables.communityReviewers, schemaTables.communityMemberships,
  schemaTables.authUsers, schemaTables.authSessions, schemaTables.authSsoRequests,
  schemaTables.authOidcFlows, schemaTables.authOidcBindings, schemaTables.authIdentityOutbox,
  schemaTables.communityGroups, schemaTables.communityGroupMemberships,
  schemaTables.joinApplications, schemaTables.joinApplicationEmailRegistry,
  schemaTables.joinApplicationForms, schemaTables.joinApplicationAttachments,
  schemaTables.joinInvitations, schemaTables.joinEmailControls, schemaTables.joinDeliveryAttempts,
  schemaTables.notificationContents, schemaTables.notificationEvents,
  schemaTables.notificationEventRecipients, schemaTables.notificationUserStreams,
  schemaTables.notificationReceipts, schemaTables.notificationPreferences,
  schemaTables.notificationMutations, schemaTables.notificationClearBatches,
  schemaTables.notificationClearBatchItems,
  schemaTables.supportFeedbackSubmissions, schemaTables.supportFeedbackAttachments,
].map(getTableConfig).flatMap(table => table.columns.filter(column => column.notNull)
  .map(column => `${table.name}.${column.name}`)))

/** Development-only reset. Lock targets and check ownership inside one transaction before DROP. */
export async function resetDatabase(options: DatabaseOptions, confirmation: string): Promise<void> {
  if (confirmation !== 'exre') throw new Error('db:reset 必须显式传入 --confirm exre。')
  const connectionString = assertDatabaseUrl(options.connectionString ?? process.env.DATABASE_URL)
  const url = new URL(connectionString)
  // assertDatabaseUrl permits only connection options that cannot replace the authority;
  // createVerifiedPool always appends and verifies the owned search_path.
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('db:reset 只允许回环地址上的 exre。')
  }
  const schema = options.searchPath ?? 'public'
  const migrationsSchema = options.searchPath ?? 'drizzle'
  if (!SAFE_IDENTIFIER.test(schema) || !SAFE_IDENTIFIER.test(migrationsSchema)) throw new Error('无效的 reset schema。')
  const pool = await createVerifiedPool({ connectionString, searchPath: options.searchPath })
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    // Lock every table we will drop before inspecting its dependent objects. DDL that
    // attaches a new dependent must wait until the reset has committed or rolled back.
    const targetTables = await client.query<{ relname: string }>(`SELECT c.relname
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relname = ANY($2::text[])`,
    [schema, DROP_ORDER])
    const lockedTables = new Set(targetTables.rows.map(row => row.relname))
    for (const table of DROP_ORDER) {
      if (lockedTables.has(table)) await client.query(`LOCK TABLE "${schema}"."${table}" IN ACCESS EXCLUSIVE MODE`)
    }
    const journal = await client.query<{ relname: string }>(`SELECT c.relname
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relname = '__drizzle_migrations'`,
    [migrationsSchema])
    const hasJournal = journal.rows.length > 0
    if (hasJournal) await client.query(`LOCK TABLE "${migrationsSchema}"."__drizzle_migrations" IN ACCESS EXCLUSIVE MODE`)

    const objects = await client.query<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f','i','I')`, [schema])
    for (const object of objects.rows) {
      const owned = object.relkind === 'i' || object.relkind === 'I'
        ? APPLICATION_INDEXES.has(object.relname) ||
          (schema === migrationsSchema && object.relname === '__drizzle_migrations_pkey')
        : APPLICATION_TABLES.includes(object.relname as typeof APPLICATION_TABLES[number]) ||
          (schema === migrationsSchema && (object.relname === '__drizzle_migrations' ||
            (object.relkind === 'S' && object.relname === '__drizzle_migrations_id_seq')))
      if (!owned) throw new Error(`目标 schema 含非本应用对象 ${object.relname}；拒绝重置。`)
    }
    if (migrationsSchema !== schema) {
      const journalObjects = await client.query<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f','i','I')`, [migrationsSchema])
      if (journalObjects.rows.some(row => row.relname !== '__drizzle_migrations' &&
        !(row.relkind === 'S' && row.relname === '__drizzle_migrations_id_seq') &&
        !(row.relkind === 'i' && row.relname === '__drizzle_migrations_pkey'))) {
        throw new Error('migration schema 含非本应用对象；拒绝重置。')
      }
    }
    const functions = await client.query<{ proname: string }>(`SELECT p.proname FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1::text[])`, [[...new Set([schema, migrationsSchema])]])
    if (functions.rows.length) throw new Error('目标或 migration schema 含非本应用函数；拒绝重置。')

    const triggers = await client.query<{ tgname: string }>(`SELECT tg.tgname FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_class t ON t.oid = tg.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT tg.tgisinternal AND ((n.nspname = $1 AND t.relname = ANY($2::text[]))
        OR (n.nspname = $3 AND t.relname = '__drizzle_migrations'))`,
      [schema, APPLICATION_TABLES, migrationsSchema])
    if (triggers.rows.length) throw new Error('目标数据表含非本应用触发器；拒绝重置。')

    const constraints = await client.query<{
      table_name: string; conname: string; contype: string; column_name: string | null; definition: string
    }>(`SELECT t.relname AS table_name, c.conname, c.contype, a.attname AS column_name,
        pg_catalog.pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE (n.nspname = $1 AND t.relname = ANY($2::text[]))
        OR (n.nspname = $3 AND t.relname = '__drizzle_migrations')`,
    [schema, APPLICATION_TABLES, migrationsSchema])
    if (constraints.rows.some(row => {
      if (row.contype === 'n') {
        const expected = row.column_name !== null && (row.table_name === '__drizzle_migrations'
          ? ['id', 'hash'].includes(row.column_name)
          : BASELINE_NOT_NULL_COLUMNS.has(`${row.table_name}.${row.column_name}`))
        return !expected || row.definition !== `NOT NULL ${row.column_name}`
      }
      if (row.table_name === '__drizzle_migrations') {
        return row.conname !== '__drizzle_migrations_pkey' || row.definition !== 'PRIMARY KEY (id)'
      }
      const key = `${row.table_name}.${row.conname}`
      return APPLICATION_CONSTRAINT_DEFINITIONS.get(key) !== row.definition
    })) {
      throw new Error('目标数据表含非本应用约束；拒绝重置。')
    }

    const indexes = await client.query<{
      tablename: string; indexname: string; indexdef: string
      indisvalid: boolean; indisready: boolean; indislive: boolean
    }>(`SELECT t.relname AS tablename, i.relname AS indexname,
        pg_catalog.pg_get_indexdef(i.oid) AS indexdef,
        x.indisvalid, x.indisready, x.indislive
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE (n.nspname = $1 AND t.relname = ANY($2::text[]))
        OR (n.nspname = $3 AND t.relname = '__drizzle_migrations')`,
    [schema, APPLICATION_TABLES, migrationsSchema])
    if (indexes.rows.some(row => {
      const expected = row.tablename === '__drizzle_migrations'
        ? (row.indexname === '__drizzle_migrations_pkey' ? 'UNIQUE btree (id)' : undefined)
        : APPLICATION_INDEX_SIGNATURES.get(`${row.tablename}.${row.indexname}`)
      return expected === undefined || indexSignature(row.indexdef) !== expected ||
        !row.indisvalid || !row.indisready || !row.indislive
    })) {
      throw new Error('目标数据表含非本应用索引定义；拒绝重置。')
    }

    // These catalog objects belong to a table and disappear with DROP TABLE,
    // without appearing in pg_class or pg_constraint. The baseline owns none.
    const attached = await client.query<{ kind: string; name: string }>(`WITH targets AS (
      SELECT t.oid FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE (n.nspname = $1 AND t.relname = ANY($2::text[]))
        OR (n.nspname = $3 AND t.relname = '__drizzle_migrations')
    )
    SELECT 'rule' AS kind, r.rulename AS name FROM pg_catalog.pg_rewrite r
      JOIN targets t ON t.oid = r.ev_class
    UNION ALL
    SELECT 'policy', p.polname FROM pg_catalog.pg_policy p
      JOIN targets t ON t.oid = p.polrelid
    UNION ALL
    SELECT 'statistics', s.stxname FROM pg_catalog.pg_statistic_ext s
      JOIN targets t ON t.oid = s.stxrelid
    UNION ALL
    SELECT 'publication', p.pubname FROM pg_catalog.pg_publication_rel pr
      JOIN pg_catalog.pg_publication p ON p.oid = pr.prpubid
      JOIN targets t ON t.oid = pr.prrelid`,
    [schema, APPLICATION_TABLES, migrationsSchema])
    if (attached.rows.length) {
      throw new Error(`目标数据表含非本应用附属对象 ${attached.rows[0]?.kind}；拒绝重置。`)
    }

    const defaults = await client.query<{
      table_name: string; column_name: string; expression: string
    }>(`SELECT t.relname AS table_name, a.attname AS column_name,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_catalog.pg_attrdef d
      JOIN pg_catalog.pg_class t ON t.oid = d.adrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.adnum
      WHERE (n.nspname = $1 AND t.relname = ANY($2::text[]))
        OR (n.nspname = $3 AND t.relname = '__drizzle_migrations')`,
    [schema, APPLICATION_TABLES, migrationsSchema])
    const journalSequence = '__drizzle_migrations_id_seq'
    const expectedJournalDefaults = new Set([
      `nextval('${migrationsSchema}.${journalSequence}'::regclass)`,
      `nextval('${journalSequence}'::regclass)`,
    ])
    if (defaults.rows.some(row => {
      if (row.table_name === '__drizzle_migrations' && row.column_name === 'id') {
        return !expectedJournalDefaults.has(row.expression)
      }
      if (row.table_name === 'auth_sessions' && row.column_name === 'id') {
        return !['gen_random_uuid()::text', '(gen_random_uuid())::text'].includes(row.expression)
      }
      if (row.table_name === 'join_applications' && row.column_name === 'legacy_read_only') return row.expression !== 'false'
      if (row.expression !== '0') return true
      const zeroDefaultColumns = new Set([
        'auth_registration_emails.code_version', 'auth_registration_emails.failed_attempts', 'communities.config_revision',
        'auth_users.profile_version', 'auth_identity_outbox.attempts',
        'join_applications.form_version', 'join_email_controls.failed_attempts',
        'notification_events.projection_attempts', 'notification_preferences.revision',
        'notification_user_streams.last_sequence', 'notification_user_streams.state_version',
        'notification_receipts.clear_revision', 'notification_receipts.state_revision',
      ])
      return !zeroDefaultColumns.has(`${row.table_name}.${row.column_name}`)
    })) {
      throw new Error('目标数据表含非本应用默认值；拒绝重置。')
    }

    for (const table of DROP_ORDER) {
      if (lockedTables.has(table)) await client.query(`DROP TABLE "${schema}"."${table}"`)
    }
    if (hasJournal) await client.query(`DROP TABLE "${migrationsSchema}"."__drizzle_migrations"`)
    await client.query('COMMIT')
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client?.release()
    await pool.end()
  }
  await runMigrations({ connectionString, searchPath: options.searchPath, migrationsSchema })
}
