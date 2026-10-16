import { createHash, randomUUID } from 'node:crypto'
import type { SqlExecutor } from '@server/src/db/client.js'
import { NotificationError } from './errors.js'
import { catalogEntry, MAX_DIRECTED_AUDIENCE, MAX_EVENT_BYTES, MAX_TEXT_CODE_POINTS, RECOMMENDED_MAX_AUDIENCE,
  MAX_TITLE_CODE_POINTS, EVENT_VERSION, type NotificationEventType } from './catalog.js'
import { assertSafeNotificationHtml, deriveSummary } from './html/sanitize.js'
import { parseStoredActions } from './actions.js'
import type { NotificationRepository } from './repository.js'

/**
 * 受控内部生产者。
 *
 * 只接受已注册的类型化业务事件，不提供「发给任意用户」的公开 operation、
 * 不自动挑选用户、不提权、不创建管理员。发布社区公告需要显式给出已有启用
 * 发布者 UUID，并核对真实的 Website admin 关系。
 *
 * 源事实、内容、事件和受众快照在同一事务中提交，任一步失败全部回滚。
 * 提交只代表通知**已经产生**，不代表已到达：站内投影由独立 worker 异步完成。
 */

export interface PublicationContent {
  title: string
  html: string
  templateId: string
  templateVersion: number
  sourceRevision: number
  /** N1 不注册可执行业务命令；这里只允许已注册的导航 descriptor。 */
  actionsJson: string
  availableAt: number | null
  expiresAt: number | null
}

export interface PublishInput {
  eventType: NotificationEventType
  dedupeKey: string
  actorUserId: string | null
  audience: { kind: 'all_active_users' } | { kind: 'users'; userIds: readonly string[] }
  content: PublicationContent
  sourceType: string
  sourceId: string
}

export interface WithdrawInput {
  dedupeKey: string
  contentId: string
  actorUserId: string | null
  sourceType: string
  sourceId: string
}

export interface PublishResult {
  eventId: string
  contentId: string
  dedupeKey: string
  audienceCount: number
  replayed: boolean
}

export interface ProducerDependencies {
  repository: NotificationRepository
  now: () => number
  createId?: () => string
}

export function normalizeTitle(rawTitle: string): string {
  const title = rawTitle.trim()
  const length = Array.from(title).length
  if (length === 0 || length > MAX_TITLE_CODE_POINTS) throw new NotificationError('CONTENT_UNSAFE')
  for (const char of title) {
    if (isTitleControlCharacter(char.codePointAt(0)!)) throw new NotificationError('CONTENT_UNSAFE')
  }
  return title
}

function isTitleControlCharacter(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

export class NotificationProducer {
  constructor(private readonly deps: ProducerDependencies) {}

  /**
   * 发布一条社区公告或必要服务提示。
   *
   * `requireAdmin` 为真时核对发布者当前的 admin 成员关系；个人通知不需要 admin。
   */
  async publish(input: PublishInput, options: { requireAdmin?: boolean } = {}): Promise<PublishResult> {
    return this.deps.repository.db.transaction(tx => this.publishInside(tx, input, options))
  }

  /** All publication queries use the caller's transaction; success is provisional until it commits. */
  async publishInside(tx: SqlExecutor, input: PublishInput, options: { requireAdmin?: boolean; occurredAt?: number } = {}): Promise<PublishResult> {
    const entry = catalogEntry(input.eventType, EVENT_VERSION)
    if (entry === undefined) throw new NotificationError('NOTIFICATION_UNSUPPORTED')
    if (!entry.createsReceipt) throw new NotificationError('NOTIFICATION_UNSUPPORTED')

    const now = this.deps.now()
    const occurredAt = options.occurredAt ?? now
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new NotificationError('CONTENT_UNSAFE')
    const title = normalizeTitle(input.content.title)
    const safe = assertSafeNotificationHtml(input.content.html)
    if (Array.from(safe.text).length > MAX_TEXT_CODE_POINTS) throw new NotificationError('CONTENT_TOO_LARGE')
    parseStoredActions(input.content.actionsJson)

    const eventId = this.deps.createId?.() ?? randomUUID()
    const contentId = this.deps.createId?.() ?? randomUUID()
    const availableAt = input.content.availableAt ?? now
    const expiresAt = input.content.expiresAt
    if (expiresAt !== null && expiresAt <= availableAt) throw new NotificationError('CONTENT_UNSAFE')

    const data = JSON.stringify({ contentId })
    if (Buffer.byteLength(data, 'utf8') + Buffer.byteLength(safe.html, 'utf8') +
        Buffer.byteLength(title, 'utf8') > MAX_EVENT_BYTES) {
      throw new NotificationError('CONTENT_TOO_LARGE')
    }

    const digest = normalizeDigest({
      eventType: input.eventType,
      title,
      html: safe.html,
      actionsJson: input.content.actionsJson,
      templateId: input.content.templateId,
      templateVersion: input.content.templateVersion,
      sourceRevision: input.content.sourceRevision,
      availableAt,
      expiresAt,
      audience: input.audience,
    })

    {
      const existing = await this.deps.repository.findEventByDedupeKey(input.dedupeKey, tx)
      if (existing !== undefined) {
        if (existing.digest !== digest) throw new NotificationError('NOTIFICATION_EVENT_CONFLICT')
        return {
          eventId: existing.event_id,
          contentId: existing.content_id ?? '',
          dedupeKey: input.dedupeKey,
          audienceCount: await countRecipients(this.deps.repository, existing.event_id, tx),
          replayed: true,
        }
      }

      if (options.requireAdmin === true) {
        if (input.actorUserId === null || !(await this.deps.repository.isAdminUser(input.actorUserId, tx))) {
          throw new NotificationError('NOTIFICATION_PUBLISH_FORBIDDEN')
        }
      }

      const userIds = await resolveAudience(this.deps.repository, input.audience, tx, entry.audiencePolicy)
      if (userIds.length === 0) throw new NotificationError('NOTIFICATION_AUDIENCE_INVALID')

      await this.deps.repository.insertContent({
        content_id: contentId,
        title,
        format: 'html',
        schema_version: 1,
        policy_version: 'notification-html-v1',
        html: safe.html,
        text: safe.text,
        summary_text: deriveSummary(safe.text),
        content_revision: 1,
        template_id: input.content.templateId,
        template_version: input.content.templateVersion,
        source_revision: input.content.sourceRevision,
        scope: entry.scope,
        category: entry.category,
        necessity: entry.necessity,
        actions_json: input.content.actionsJson,
        available_at: availableAt,
        expires_at: expiresAt,
        withdrawn_at: null,
        actor_user_id: input.actorUserId,
        created_at: now,
      }, tx)

      await this.deps.repository.insertEvent({
        event_id: eventId,
        event_type: input.eventType,
        event_version: EVENT_VERSION,
        occurred_at: occurredAt,
        source_type: input.sourceType,
        source_id: input.sourceId,
        source_revision: input.content.sourceRevision,
        scope: entry.scope,
        dedupe_key: input.dedupeKey,
        digest,
        actor_user_id: input.actorUserId,
        data_json: data,
        content_id: contentId,
        projection_status: 'pending',
        projection_attempts: 0,
        projection_lease_owner: null,
        projection_lease_expires_at: null,
        projection_next_attempt_at: now,
        projection_completed_at: null,
        projection_error_code: null,
      }, tx)

      await this.deps.repository.insertRecipients(eventId, userIds, tx)

      return { eventId, contentId, dedupeKey: input.dedupeKey, audienceCount: userIds.length, replayed: false }
    }
  }

  /**
   * 撤回：与内容生命周期在同一事务，独立事件不再创建 receipt。
   *
   * `requireAdmin` 与 `publish` 对称：撤回同样会让已投递的通知从所有收件人处消失，
   * 授权要求不能比发布更松。N1 两者都还没有 HTTP 入口，但对称性必须从一开始就成立。
   */
  async withdraw(input: WithdrawInput,
    options: { requireAdmin?: boolean } = {}): Promise<{ eventId: string; replayed: boolean }> {
    const entry = catalogEntry('community.announcement.withdrawn', EVENT_VERSION)
    if (entry === undefined) throw new NotificationError('NOTIFICATION_UNSUPPORTED')
    const now = this.deps.now()
    const eventId = this.deps.createId?.() ?? randomUUID()
    const data = JSON.stringify({ contentId: input.contentId, withdrawnAt: now })
    const digest = normalizeDigest({ eventType: 'community.announcement.withdrawn', contentId: input.contentId })

    return await this.deps.repository.db.transaction(async tx => {
      const existing = await this.deps.repository.findEventByDedupeKey(input.dedupeKey, tx)
      if (existing !== undefined) {
        if (existing.digest !== digest) throw new NotificationError('NOTIFICATION_EVENT_CONFLICT')
        return { eventId: existing.event_id, replayed: true }
      }
      if (options.requireAdmin === true) {
        if (input.actorUserId === null || !(await this.deps.repository.isAdminUser(input.actorUserId, tx))) {
          throw new NotificationError('NOTIFICATION_PUBLISH_FORBIDDEN')
        }
      }
      const updated = await this.deps.repository.withdrawContent(input.contentId, now, tx)
      if (updated !== 1) throw new NotificationError('NOTIFICATION_NOT_FOUND')
      await this.deps.repository.insertEvent({
        event_id: eventId,
        event_type: 'community.announcement.withdrawn',
        event_version: EVENT_VERSION,
        occurred_at: now,
        source_type: input.sourceType,
        source_id: input.sourceId,
        source_revision: 1,
        scope: entry.scope,
        dedupe_key: input.dedupeKey,
        digest,
        actor_user_id: input.actorUserId,
        data_json: data,
        content_id: input.contentId,
        projection_status: 'completed',
        projection_attempts: 0,
        projection_lease_owner: null,
        projection_lease_expires_at: null,
        projection_next_attempt_at: now,
        projection_completed_at: now,
        projection_error_code: null,
      }, tx)
      return { eventId, replayed: false }
    })
  }
}

async function resolveAudience(repository: NotificationRepository,
  audience: PublishInput['audience'], tx: SqlExecutor, policy?: 'single_existing_user'): Promise<string[]> {
  if (policy === 'single_existing_user') {
    if (audience.kind !== 'users' || audience.userIds.length !== 1) throw new NotificationError('NOTIFICATION_AUDIENCE_INVALID')
    const existing = await repository.existingUserIds(audience.userIds, tx)
    if (existing.size !== 1) throw new NotificationError('NOTIFICATION_AUDIENCE_INVALID')
    return [...audience.userIds]
  }
  if (audience.kind === 'users') {
    const unique = [...new Set(audience.userIds)]
    if (unique.length === 0 || unique.length > MAX_DIRECTED_AUDIENCE) {
      throw new NotificationError('NOTIFICATION_AUDIENCE_INVALID')
    }
    const existing = await repository.usersExist(unique, tx)
    // 未知或停用账号整体拒绝并零提交，不静默缩小受众。
    if (existing.size !== unique.length) throw new NotificationError('NOTIFICATION_AUDIENCE_INVALID')
    return unique.sort()
  }
  return repository.activeUserIds(RECOMMENDED_MAX_AUDIENCE, tx)
}

async function countRecipients(repository: NotificationRepository, eventId: string, tx: SqlExecutor): Promise<number> {
  const result = await tx.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM notification_event_recipients WHERE event_id = $1', [eventId])
  return Number(result.rows[0]?.count ?? 0)
}

/** 规范化摘要：同 key 同摘要重放返回原事实，异摘要冲突。 */
export function normalizeDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
