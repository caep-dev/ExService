import { createHash, randomUUID } from 'node:crypto'
import type { components } from '@workspace/api-client/types'
import { AuthError } from '../../../modules/auth/errors.js'
import type { AuthService, SessionIdentity } from '../../../modules/auth/service.js'
import type { AppDatabase, SqlExecutor } from '../../../db/client.js'
import { CommunityError } from '../../../modules/communities/errors.js'
import type { CommunityService } from '../../../modules/communities/service.js'
import type { IdentityLinkService } from '../../../modules/identity-links/service.js'
import type { NotificationProducer } from '../../../modules/notifications/producer.js'
import { detail, summary, type ApplicationRow } from './records.js'
import { validateJoinApplicationPayload } from './form-validation.js'
import { validateJoinProofs, type JoinProofInput } from './attachment-validation.js'
import { JoinRateLimiter } from './rate-limiter.js'
export type { JoinApplicationInput } from './form-validation.js'
export type { JoinProofInput } from './attachment-validation.js'

export interface JoinServiceDependencies {
  db: AppDatabase
  authServices: AuthService
  communityServices: CommunityService
  identityLinkServices: IdentityLinkService
  notifications: { producer: NotificationProducer }
  now?: () => number
  createId?: () => string
}
export interface ListQuery {
  status?: 'pending' | 'approved' | 'rejected'
  source?: 'live' | 'legacy' | 'all'
  limit?: number
  offset?: number
}
export class JoinService {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly limiter: JoinRateLimiter
  constructor(private readonly deps: JoinServiceDependencies) {
    this.now = deps.now ?? Date.now
    this.createId = deps.createId ?? randomUUID
    this.limiter = new JoinRateLimiter(this.now)
  }
  limit(ip: string) {
    const retry = this.limiter.check(ip)
    if (retry !== undefined) throw new AuthError('JOIN_RATE_LIMITED', { retryAfterSeconds: retry })
  }
  async submit(
    session: SessionIdentity,
    communityId: string,
    value: unknown,
    proofs: JoinProofInput[] = [],
  ) {
    const input = validateJoinApplicationPayload(value, this.now()),
      attachments = validateJoinProofs(proofs, input.form.applicationType)
    try {
      await this.deps.db.transaction(async (tx) => {
        await this.deps.communityServices.lockAccountsInside(tx, [session.userId])
        await this.deps.authServices.assertSessionCurrent(session, tx, true)
        await this.deps.communityServices.getCommunityInside(tx, communityId, 'share')
        if (
          (
            await tx.query(
              'SELECT id FROM join_applications WHERE user_id=$1 AND community_id=$2',
              [session.userId, communityId],
            )
          ).rows.length
        )
          throw new AuthError('JOIN_APPLICATION_EXISTS')
        const requirements = await this.deps.communityServices.requirementsInside(
          tx,
          communityId,
          session.userId,
        )
        if (!requirements.requirementsMet) throw new CommunityError('COMMUNITY_REQUIREMENT_UNMET')
        const owner = (
          await tx.query<{ email: string; nickname: string }>(
            'SELECT email,nickname FROM auth_users WHERE id=$1',
            [session.userId],
          )
        ).rows[0]!
        const link = (await this.deps.identityLinkServices.listInside(tx, session.userId)).find(
          (item) => item.provider === 'cfx',
        )
        const identitySnapshot = link
          ? {
              provider: 'cfx',
              externalUserId: link.externalUserId,
              externalUsername: link.externalUsername,
              linkedAt: link.linkedAt,
            }
          : null
        const id = this.createId(),
          now = this.now()
        await tx.query(
          `INSERT INTO join_applications(id,email,nickname,qq,status,created_at,form_version,community_id,user_id,legacy_read_only,identity_snapshot_json)
          VALUES($1,$2,$3,$4,'pending',$5,1,$6,$7,false,$8)`,
          [
            id,
            owner.email,
            owner.nickname,
            input.qq,
            now,
            communityId,
            session.userId,
            identitySnapshot ? JSON.stringify(identitySnapshot) : null,
          ],
        )
        await tx.query(
          'INSERT INTO join_application_forms(application_id,version,application_type,form_json) VALUES($1,1,$2,$3)',
          [id, input.form.applicationType, JSON.stringify(input.form)],
        )
        for (const file of attachments)
          await tx.query(
            `INSERT INTO join_application_attachments(id,application_id,ordinal,original_name,extension,sha256,byte_length,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              this.createId(),
              id,
              file.ordinal,
              file.originalName,
              file.extension,
              file.sha256,
              file.byteLength,
              file.bytes,
            ],
          )
      })
    } catch (error) {
      if (
        (error as { code?: string; constraint?: string }).code === '23505' &&
        (error as { constraint?: string }).constraint === 'join_applications_user_community_unique'
      )
        throw new AuthError('JOIN_APPLICATION_EXISTS')
      throw error
    }
    return { status: 'received' as const }
  }
  async list(session: SessionIdentity, communityId: string, query: ListQuery = {}) {
    const { status, source = 'live', limit = 20, offset = 0 } = query
    if (
      (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) ||
      !['live', 'legacy', 'all'].includes(source) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new AuthError('BAD_REQUEST')
    return this.deps.db.transaction(async (tx) => {
      await this.deps.communityServices.assertReviewerReadInside(tx, session, communityId)
      const predicate = `community_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3='all' OR legacy_read_only=($3='legacy'))`
      const rows = (
        await tx.query<ApplicationRow>(
          `SELECT * FROM join_applications WHERE ${predicate} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
          [communityId, status ?? null, source, limit, offset],
        )
      ).rows
      const total = Number(
        (
          await tx.query<{ n: number }>(
            `SELECT count(*) AS n FROM join_applications WHERE ${predicate}`,
            [communityId, status ?? null, source],
          )
        ).rows[0]!.n,
      )
      const now = this.now(),
        items: components['schemas']['JoinApplicationSummary'][] = []
      for (const row of rows) items.push(await summary(tx, row, now, await this.missing(tx, row)))
      return { items, total, offset, limit, serverTime: now }
    }, 'repeatable-read-read-only')
  }
  async get(session: SessionIdentity, communityId: string, id: string) {
    return this.deps.db.transaction(async (tx) => {
      await this.deps.communityServices.assertReviewerReadInside(tx, session, communityId)
      return this.details(tx, await this.require(tx, communityId, id))
    }, 'repeatable-read-read-only')
  }
  async download(
    session: SessionIdentity,
    communityId: string,
    applicationId: string,
    attachmentId: string,
  ) {
    return this.deps.db.transaction(async (tx) => {
      await this.deps.communityServices.assertReviewerReadInside(tx, session, communityId)
      await this.require(tx, communityId, applicationId)
      const row = (
        await tx.query<{
          original_name: string
          bytes: Buffer
          byte_length: number
          sha256: string
        }>(
          `SELECT f.original_name,f.bytes,f.byte_length,f.sha256 FROM join_application_attachments f JOIN join_applications a ON a.id=f.application_id WHERE a.community_id=$1 AND f.application_id=$2 AND f.id=$3`,
          [communityId, applicationId, attachmentId],
        )
      ).rows[0]
      if (!row) throw new AuthError('JOIN_ATTACHMENT_NOT_FOUND')
      if (
        !Buffer.isBuffer(row.bytes) ||
        row.bytes.length !== row.byte_length ||
        createHash('sha256').update(row.bytes).digest('hex') !== row.sha256
      )
        throw new Error('Join application attachment bytes are inconsistent')
      return {
        originalName: row.original_name,
        bytes: row.bytes,
        byteLength: row.byte_length,
        sha256: row.sha256,
      }
    }, 'repeatable-read-read-only')
  }
  approve(session: SessionIdentity, communityId: string, id: string) {
    return this.decide(session, communityId, id, 'approved')
  }
  reject(session: SessionIdentity, communityId: string, id: string) {
    return this.decide(session, communityId, id, 'rejected')
  }
  private async decide(
    session: SessionIdentity,
    communityId: string,
    id: string,
    status: 'approved' | 'rejected',
  ) {
    return this.deps.db.transaction(async (tx) => {
      // Discovery only gathers accounts for deterministic locks; authorization precedes returned content.
      const candidate = (
        await tx.query<{ user_id: string | null }>(
          'SELECT user_id FROM join_applications WHERE id=$1 AND community_id=$2',
          [id, communityId],
        )
      ).rows[0]
      await this.deps.communityServices.lockAccountsInside(tx, [
        session.userId,
        ...(candidate?.user_id ? [candidate.user_id] : []),
      ])
      await this.deps.authServices.assertSessionCurrent(session, tx, true)
      const community = await this.deps.communityServices.assertReviewerInside(
        tx,
        session,
        communityId,
        true,
      )
      const row = await this.require(tx, communityId, id, true)
      if (row.user_id !== candidate?.user_id) throw new AuthError('JOIN_STATE_CONFLICT')
      if (row.legacy_read_only) throw new JoinHistoryError()
      if (row.status === status) return this.details(tx, row)
      if (row.status !== 'pending' || !row.user_id) throw new AuthError('JOIN_STATE_CONFLICT')
      await this.details(tx, row)
      const now = this.now()
      await tx.query(
        'UPDATE join_applications SET status=$2,reviewed_at=$3,reviewed_by_user_id=$4 WHERE id=$1',
        [id, status, now, session.userId],
      )
      if (status === 'approved')
        await this.deps.communityServices.insertMembershipInside(tx, {
          userId: row.user_id,
          communityId,
          applicationId: id,
          joinedAt: now,
        })
      await this.deps.notifications.producer.publishInside(
        tx,
        {
          eventType: `join.application.${status}`,
          dedupeKey: `join-result:${id}:${status}`,
          actorUserId: session.userId,
          audience: { kind: 'users', userIds: [row.user_id] },
          sourceType: 'join_application',
          sourceId: id,
          content: {
            title: status === 'approved' ? '社区申请已通过' : '社区申请未通过',
            html: `<p>您在 ${escapeHtml(community.displayName)} 的申请${status === 'approved' ? '已通过' : '未通过'}。</p>`,
            templateId: `join.application.${status}`,
            templateVersion: 1,
            sourceRevision: 1,
            actionsJson: JSON.stringify([
              {
                kind: 'navigate',
                actionId: 'view-result',
                targetKey: 'community.application-result',
                emphasis: 'primary',
              },
            ]),
            availableAt: now,
            expiresAt: null,
          },
        },
        { occurredAt: now },
      )
      return this.details(tx, {
        ...row,
        status,
        reviewed_at: now,
        reviewed_by_user_id: session.userId,
      })
    })
  }
  private async missing(tx: SqlExecutor, row: ApplicationRow): Promise<Array<'cfx'>> {
    if (row.user_id)
      return (
        await this.deps.communityServices.requirementsInside(tx, row.community_id, row.user_id)
      ).missingProviders
    return (await this.deps.communityServices.getCommunityInside(tx, row.community_id)).requiresCfx
      ? ['cfx']
      : []
  }
  private async details(tx: SqlExecutor, row: ApplicationRow) {
    return detail(tx, row, this.now(), await this.missing(tx, row))
  }
  private async require(tx: SqlExecutor, communityId: string, id: string, lock = false) {
    const row = (
      await tx.query<ApplicationRow>(
        `SELECT * FROM join_applications WHERE community_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [communityId, id],
      )
    ).rows[0]
    if (!row) throw new AuthError('JOIN_APPLICATION_NOT_FOUND')
    return row
  }
}
class JoinHistoryError extends Error {
  readonly code = 'JOIN_HISTORY_READ_ONLY'
  readonly statusCode = 409
  readonly publicMessage = '历史申请为只读记录。'
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}
