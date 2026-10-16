import { createHash } from 'node:crypto'
import { Ajv } from 'ajv'
import type { SqlExecutor } from './client.js'
import historicalForms from './public-registration-history-forms.json' with { type: 'json' }

// Frozen storage-version-1 schema from the pre-cutover Contract. Future HTTP
// payload changes must not silently redefine whether historical data is valid.
const validateForm = new Ajv({ strict: false, allErrors: false }).compile(historicalForms)
export type HistoryConflictCode = 'COMPLETED_INVITATION_INVALID' | 'DUPLICATE_APPLICATION_MAPPING' |
  'DUPLICATE_ACCOUNT_MAPPING' | 'APPLICATION_TIME_INVALID' | 'FORM_INVALID' | 'ATTACHMENT_INVALID' | 'ORPHAN_HISTORY'
export interface PublicRegistrationHistoryInventory {
  counts: { applications: number; mappedApplications: number; unownedApplications: number; forms: number; attachments: number; invitations: number; deliveries: number }
  conflicts: Partial<Record<HistoryConflictCode, number>>
}
const timestamp = (value: unknown): value is number | string => value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= 0
function validStoredForm(value: unknown, createdAt: number): boolean {
  if (!validateForm(value)) return false
  const form = value as { birthDate: string; freeTime: string; answers: Record<string, string> }
  const date = new Date(`${form.birthDate}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === form.birthDate && date.getTime() <= createdAt &&
    [form.freeTime, ...Object.values(form.answers)].every(text => text === text.trim())
}

/** Read only. Call within a repeatable-read snapshot for standalone inventory;
 * the migration instead holds write-blocking locks until validation and upgrade commit. */
export async function inspectPublicRegistrationHistory(executor: SqlExecutor): Promise<PublicRegistrationHistoryInventory> {
  const result: PublicRegistrationHistoryInventory = { counts: { applications: 0, mappedApplications: 0, unownedApplications: 0, forms: 0, attachments: 0, invitations: 0, deliveries: 0 }, conflicts: {} }
  const conflict = (code: HistoryConflictCode, count = 1) => { if (count) result.conflicts[code] = (result.conflicts[code] ?? 0) + count }
  for (const [key, table] of Object.entries({ applications: 'join_applications', forms: 'join_application_forms', attachments: 'join_application_attachments', invitations: 'join_invitations', deliveries: 'join_delivery_attempts' })) {
    const count = await executor.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)
    result.counts[key as keyof typeof result.counts] = Number(count.rows[0]!.n)
  }
  const mappings = (await executor.query<{ application_id: string; completed_user_id: string; completed_at: string; reviewed_at: string; created_at: string; user_created_at: string; status: string; user_exists: boolean }>(`SELECT i.application_id,i.completed_user_id,i.completed_at,a.reviewed_at,a.created_at,u.created_at AS user_created_at,a.status,u.id IS NOT NULL AS user_exists
    FROM join_invitations i LEFT JOIN join_applications a ON a.id=i.application_id LEFT JOIN auth_users u ON u.id=i.completed_user_id WHERE i.status='completed'`)).rows
  const applications = new Set<string>(), users = new Set<string>()
  for (const mapping of mappings) {
    if (applications.has(mapping.application_id)) conflict('DUPLICATE_APPLICATION_MAPPING')
    if (users.has(mapping.completed_user_id)) conflict('DUPLICATE_ACCOUNT_MAPPING')
    applications.add(mapping.application_id); users.add(mapping.completed_user_id)
    if (!mapping.user_exists || mapping.status !== 'approved' || !timestamp(mapping.completed_at) || !timestamp(mapping.reviewed_at) ||
        !timestamp(mapping.user_created_at) || Number(mapping.completed_at) < Number(mapping.reviewed_at) || Number(mapping.completed_at) < Number(mapping.user_created_at)) conflict('COMPLETED_INVITATION_INVALID')
  }
  result.counts.mappedApplications = applications.size
  result.counts.unownedApplications = result.counts.applications - applications.size
  const orphans = await executor.query<{ n: string }>(`SELECT count(*) AS n FROM (
    SELECT f.application_id FROM join_application_forms f LEFT JOIN join_applications a ON a.id=f.application_id WHERE a.id IS NULL
    UNION ALL SELECT f.application_id FROM join_application_attachments f LEFT JOIN join_applications a ON a.id=f.application_id WHERE a.id IS NULL
    UNION ALL SELECT i.application_id FROM join_invitations i LEFT JOIN join_applications a ON a.id=i.application_id WHERE a.id IS NULL
    UNION ALL SELECT d.invitation_id FROM join_delivery_attempts d LEFT JOIN join_invitations i ON i.id=d.invitation_id WHERE i.id IS NULL
  ) orphaned`)
  conflict('ORPHAN_HISTORY', Number(orphans.rows[0]!.n))
  type HistoricalApplication = { id: string; status: string; created_at: string; reviewed_at: string | null; reviewed_by_user_id: string | null; form_version: number; version: number | null; application_type: string | null; form_json: string | null }
  let cursor: string | null = null
  for (;;) {
    const rows: HistoricalApplication[] = (await executor.query<HistoricalApplication>(`SELECT a.id,a.status,a.created_at,a.reviewed_at,a.reviewed_by_user_id,a.form_version,f.version,f.application_type,f.form_json
      FROM join_applications a LEFT JOIN join_application_forms f ON f.application_id=a.id
      WHERE ($1::text IS NULL OR a.id > $1) ORDER BY a.id LIMIT 100`, [cursor])).rows
    if (!rows.length) break
    for (const row of rows) {
      if (!timestamp(row.created_at) || (row.status === 'pending' ? row.reviewed_at !== null || row.reviewed_by_user_id !== null : !timestamp(row.reviewed_at) || Number(row.reviewed_at) < Number(row.created_at))) conflict('APPLICATION_TIME_INVALID')
      let form: { applicationType?: string } | null = null
      try { if (row.form_json !== null) form = JSON.parse(row.form_json) } catch { /* safe code below */ }
      if (row.form_version === 0 ? row.version !== null : row.form_version !== 1 || row.version !== 1 || form?.applicationType !== row.application_type || !validStoredForm(form, Number(row.created_at))) conflict('FORM_INVALID')
      const attachments = (await executor.query<{ ordinal: number; byte_length: number; bytes: Buffer; sha256: string }>('SELECT ordinal,byte_length,bytes,sha256 FROM join_application_attachments WHERE application_id=$1 ORDER BY ordinal', [row.id])).rows
      if (attachments.length && (row.form_version !== 1 || row.application_type !== 'experienced' || attachments.length > 5)) conflict('ATTACHMENT_INVALID')
      attachments.forEach((attachment, index) => {
        if (attachment.ordinal !== index || !Buffer.isBuffer(attachment.bytes) || attachment.byte_length < 1 || attachment.byte_length > 10485760 || attachment.bytes.length !== attachment.byte_length || createHash('sha256').update(attachment.bytes).digest('hex') !== attachment.sha256) conflict('ATTACHMENT_INVALID')
      })
    }
    cursor = rows.at(-1)!.id
  }
  return result
}

export async function assertPublicRegistrationHistory(executor: SqlExecutor): Promise<void> {
  const inventory = await inspectPublicRegistrationHistory(executor)
  if (Object.keys(inventory.conflicts).length) throw new Error(`PUBLIC_REGISTRATION_HISTORY_CONFLICT: ${Object.keys(inventory.conflicts).sort().join(',')}`)
}
