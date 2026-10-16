import type { SqlExecutor } from '@server/src/db/client.js'

const required: Record<string, string[]> = {
  join_applications: [
    'id',
    'email',
    'nickname',
    'qq',
    'status',
    'created_at',
    'reviewed_at',
    'reviewed_by_user_id',
    'form_version',
    'community_id',
    'user_id',
    'legacy_read_only',
    'identity_snapshot_json',
  ],
  join_application_email_registry: ['email', 'canonical_application_id'],
  join_application_forms: ['application_id', 'version', 'application_type', 'form_json'],
  join_application_attachments: [
    'id',
    'application_id',
    'ordinal',
    'original_name',
    'extension',
    'sha256',
    'byte_length',
    'bytes',
  ],
  join_invitations: [
    'id',
    'application_id',
    'status',
    'issued_at',
    'expires_at',
    'code_version',
    'code_digest',
    'code_expires_at',
    'completion_token_hash',
    'completion_expires_at',
    'completed_user_id',
    'completed_at',
  ],
  join_email_controls: ['email', 'next_send_at', 'failure_window_started_at', 'failed_attempts'],
  join_delivery_attempts: [
    'id',
    'invitation_id',
    'code_version',
    'started_at',
    'finished_at',
    'status',
  ],
}
const requiredIndexes = [
  'join_applications_user_community_unique',
  'join_applications_identity_unique',
  'join_applications_community_list_idx',
  'join_applications_owner_idx',
  'join_applications_id_email_unique',
  'join_applications_email_history_idx',
  'join_application_attachments_ordinal_unique',
  'join_invitations_active_application_unique',
  'join_invitations_completion_token_unique',
  'join_delivery_attempts_version_unique',
]

/** A read-only startup check. Migration and reset remain explicit CLI operations. */
export async function assertJoinSchemaAvailable(db: SqlExecutor): Promise<void> {
  const columns = (
    await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [Object.keys(required)],
    )
  ).rows
  const byTable = new Map<string, Set<string>>()
  for (const row of columns) {
    const set = byTable.get(row.table_name) ?? new Set<string>()
    set.add(row.column_name)
    byTable.set(row.table_name, set)
  }
  for (const [table, names] of Object.entries(required)) {
    if (names.some((name) => !byTable.get(table)?.has(name)))
      throw new Error(`加入流程结构缺失（${table}）；请运行 pnpm db:migrate。`)
  }
  const indexes = new Set(
    (
      await db.query<{ indexname: string }>(
        'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])',
        [requiredIndexes],
      )
    ).rows.map((row) => row.indexname),
  )
  for (const index of requiredIndexes) {
    if (!indexes.has(index))
      throw new Error(`加入流程索引缺失（${index}）；请运行 pnpm db:migrate。`)
  }
}
