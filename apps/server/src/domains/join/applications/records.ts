import type { components } from '@workspace/api-client/types'
import type { SqlExecutor } from '@server/src/db/client.js'
import {
  validateStoredJoinForm,
  validateIdentitySnapshot,
  type JoinForm,
} from './form-validation.js'
export interface ApplicationRow {
  id: string
  email: string
  nickname: string
  qq: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: number
  reviewed_at: number | null
  reviewed_by_user_id: string | null
  form_version: 0 | 1
  community_id: string
  user_id: string | null
  legacy_read_only: boolean
  identity_snapshot_json: string | null
}
export interface InvitationRow {
  id: string
  application_id: string
  status: 'active' | 'expired' | 'completed'
  issued_at: number
  expires_at: number
  code_version: number
  code_digest: string | null
  code_expires_at: number | null
  completion_token_hash: string | null
  completion_expires_at: number | null
  completed_user_id: string | null
  completed_at: number | null
}
export interface ControlRow {
  email: string
  next_send_at: number
  failure_window_started_at: number | null
  failed_attempts: number
}
export interface DeliveryRow {
  id: string
  status: 'pending' | 'sent' | 'failed'
  started_at: number
  finished_at: number | null
}
export function effectiveStatus(row: InvitationRow, now: number) {
  return row.status === 'active' && now >= row.expires_at ? ('expired' as const) : row.status
}
export async function application(db: SqlExecutor, id: string) {
  return (await db.query<ApplicationRow>('SELECT * FROM join_applications WHERE id=$1', [id]))
    .rows[0]
}
export async function latestInvitation(db: SqlExecutor, id: string) {
  return (
    await db.query<InvitationRow>(
      'SELECT * FROM join_invitations WHERE application_id=$1 ORDER BY issued_at DESC,id DESC LIMIT 1',
      [id],
    )
  ).rows[0]
}
export async function control(db: SqlExecutor, email: string) {
  return (await db.query<ControlRow>('SELECT * FROM join_email_controls WHERE email=$1', [email]))
    .rows[0]
}
export async function latestDelivery(db: SqlExecutor, id: string) {
  return (
    await db.query<DeliveryRow>(
      'SELECT id,status,started_at,finished_at FROM join_delivery_attempts WHERE invitation_id=$1 ORDER BY code_version DESC LIMIT 1',
      [id],
    )
  ).rows[0]
}
export async function applicationForm(
  db: SqlExecutor,
  row: ApplicationRow,
  now: number,
): Promise<JoinForm | null> {
  const stored = (
    await db.query<{
      version: number
      application_type: string
      form_json: string
    }>(
      'SELECT version,application_type,form_json FROM join_application_forms WHERE application_id=$1',
      [row.id],
    )
  ).rows[0]
  if (row.form_version === 0) {
    if (stored || !row.legacy_read_only)
      throw new Error('Legacy join application version is inconsistent')
    return null
  }
  if (row.form_version !== 1 || !stored || stored.version !== 1)
    throw new Error('Join application versioned form is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(stored.form_json)
  } catch {
    throw new Error('Join application versioned form is invalid')
  }
  const form = validateStoredJoinForm(parsed, now)
  if (form.applicationType !== stored.application_type)
    throw new Error('Join application versioned form type is inconsistent')
  return form
}
export type AttachmentMetadata = components['schemas']['JoinApplicationAttachment']
export async function attachmentMetadata(
  db: SqlExecutor,
  row: ApplicationRow,
  form: JoinForm | null,
): Promise<AttachmentMetadata[]> {
  const rows = (
    await db.query<{
      id: string
      original_name: string
      extension: AttachmentMetadata['extension']
      byte_length: number
      sha256: string
      ordinal: number
    }>(
      'SELECT id,original_name,extension,byte_length,sha256,ordinal FROM join_application_attachments WHERE application_id=$1 ORDER BY ordinal',
      [row.id],
    )
  ).rows
  if ((form?.applicationType !== 'experienced' && rows.length) || rows.length > 5)
    throw new Error('Join application attachments are inconsistent')
  return rows.map((item) => ({
    id: item.id,
    originalName: item.original_name,
    extension: item.extension,
    byteLength: item.byte_length,
    sha256: item.sha256,
    ordinal: item.ordinal,
  }))
}
async function history(db: SqlExecutor, row: ApplicationRow, now: number) {
  const invitation = await latestInvitation(db, row.id),
    delivery = invitation && (await latestDelivery(db, invitation.id))
  return {
    invitationStatus: invitation ? effectiveStatus(invitation, now) : null,
    deliveryStatus: delivery?.status ?? null,
    invitation: invitation
      ? {
          id: invitation.id,
          status: effectiveStatus(invitation, now),
          issuedAt: invitation.issued_at,
          expiresAt: invitation.expires_at,
          codeExpiresAt:
            invitation.code_expires_at !== null && now < invitation.code_expires_at
              ? invitation.code_expires_at
              : null,
          completedAt: invitation.completed_at,
          completedUserId: invitation.completed_user_id,
          resendAvailableAt: Math.max(now, (await control(db, row.email))?.next_send_at ?? now),
          latestDelivery: delivery
            ? {
                id: delivery.id,
                status: delivery.status,
                startedAt: delivery.started_at,
                finishedAt: delivery.finished_at,
              }
            : null,
        }
      : null,
  }
}
function common(row: ApplicationRow, missingProviders: Array<'cfx'>) {
  let snapshot: unknown = null
  if (row.identity_snapshot_json !== null) {
    try {
      snapshot = JSON.parse(row.identity_snapshot_json)
    } catch {
      throw new Error('Stored join identity snapshot is invalid')
    }
  }
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    qq: row.qq,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedByUserId: row.reviewed_by_user_id,
    communityId: row.community_id,
    identitySnapshot: validateIdentitySnapshot(snapshot),
    missingProviders,
  }
}
export async function detail(
  db: SqlExecutor,
  row: ApplicationRow,
  now: number,
  missingProviders: Array<'cfx'> = [],
): Promise<components['schemas']['JoinApplicationDetail']> {
  const form = await applicationForm(db, row, now),
    attachments = await attachmentMetadata(db, row, form),
    base = common(row, missingProviders)
  if (!row.legacy_read_only) {
    if (!row.user_id || !form) throw new Error('Live join application owner or form is missing')
    const application = {
      ...base,
      applicantUserId: row.user_id,
      legacyReadOnly: false as const,
    }
    if (form.applicationType === 'new')
      return {
        application: { ...application, applicationType: 'new' },
        serverTime: now,
        formVersion: 1,
        form,
        attachments: [],
      }
    return {
      application: { ...application, applicationType: 'experienced' },
      serverTime: now,
      formVersion: 1,
      form,
      attachments,
    }
  }
  const { invitation, ...statuses } = await history(db, row, now)
  const application = {
    ...base,
    ...statuses,
    applicantUserId: row.user_id,
    legacyReadOnly: true as const,
  }
  if (!form)
    return {
      application: { ...application, applicationType: 'legacy' },
      invitation,
      serverTime: now,
      formVersion: 0,
      form: null,
      attachments: [],
    }
  if (form.applicationType === 'new')
    return {
      application: { ...application, applicationType: 'new' },
      invitation,
      serverTime: now,
      formVersion: 1,
      form,
      attachments: [],
    }
  return {
    application: { ...application, applicationType: 'experienced' },
    invitation,
    serverTime: now,
    formVersion: 1,
    form,
    attachments,
  }
}
export async function summary(
  db: SqlExecutor,
  row: ApplicationRow,
  now: number,
  missingProviders: Array<'cfx'> = [],
): Promise<components['schemas']['JoinApplicationSummary']> {
  return (await detail(db, row, now, missingProviders)).application
}
