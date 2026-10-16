import type { AppDatabase, SqlExecutor } from '@server/src/db/client.js'
import type { NotificationCategory, NotificationScope } from './catalog.js'

/**
 * 持久通知的数据访问层。
 *
 * 所有查询都以 `userId` 为第一约束：不存在「按 notificationId 读任意人」的路径。
 * 锁顺序沿用 user → stream → content → receipt，与清理/投影一致，避免死锁。
 * 每个方法都接收显式的 executor，因此调用方可以把它放进既有事务里。
 */

export interface NotificationEventRow {
  event_id: string
  event_type: string
  event_version: number
  occurred_at: number
  source_type: string
  source_id: string
  source_revision: number
  scope: NotificationScope
  dedupe_key: string
  digest: string
  actor_user_id: string | null
  data_json: string
  content_id: string | null
  projection_status: 'pending' | 'completed' | 'failed'
  projection_attempts: number
  projection_lease_owner: string | null
  projection_lease_expires_at: number | null
  projection_next_attempt_at: number
  projection_completed_at: number | null
  projection_error_code: string | null
}

export interface NotificationContentRow {
  content_id: string
  title: string
  format: string
  schema_version: number
  policy_version: string
  html: string
  text: string
  summary_text: string
  content_revision: number
  template_id: string
  template_version: number
  source_revision: number
  scope: NotificationScope
  category: NotificationCategory
  necessity: 'optional' | 'necessary'
  actions_json: string
  available_at: number
  expires_at: number | null
  withdrawn_at: number | null
  actor_user_id: string | null
  created_at: number
}

export interface ReceiptListRow {
  receipt_id: string
  user_id: string
  content_id: string
  event_id: string
  sequence: number
  scope: NotificationScope
  delivered_at: number
  read_at: number | null
  cleared_at: number | null
  clear_batch_id: string | null
  clear_revision: number
  state_revision: number
  title: string
  summary_text: string
  category: NotificationCategory
  necessity: 'optional' | 'necessary'
  available_at: number
  expires_at: number | null
  withdrawn_at: number | null
}

export interface ClearBatchRow {
  batch_id: string
  user_id: string
  snapshot_id: string
  upper_sequence: number
  preview_expires_at: number
  status: 'preview' | 'applied' | 'restored'
  request_id: string | null
  item_count: number
  affected_count: number | null
  skipped_count: number | null
  created_at: number
  applied_at: number | null
  restored_at: number | null
}

const RECEIPT_SELECT = `
  SELECT r.receipt_id, r.user_id, r.content_id, r.event_id, r.sequence, r.scope, r.delivered_at,
      r.read_at, r.cleared_at, r.clear_batch_id, r.clear_revision, r.state_revision,
      c.title, c.summary_text, c.category, c.necessity, c.available_at, c.expires_at, c.withdrawn_at
    FROM notification_receipts r
    JOIN notification_contents c ON c.content_id = r.content_id`

/**
 * 可读基准 `P`：本人 receipt + 内容已生效 + 未撤回 + 未清理（调用方按需加）。
 * 过期不移除：过期项仍可在 history 中阅读，只是不计未读、不可执行 Action。
 */
const VISIBLE_CONTENT = `r.user_id = $1 AND c.available_at <= $2 AND c.withdrawn_at IS NULL`

/**
 * 未清理 receipt 的可读基准：在 `P` 之上排除已清理项。
 *
 * 已清理项不属于 history，因此单条 GET 与 PATCH state 也必须与列表一致地拒绝它。
 * 凡是「本人可见且未清理」的读与批量写都用它，不要在调用处再拼一次 `cleared_at IS NULL` ——
 * 拼漏一处就会出现「列表看不到、单条却能读写」的不一致。
 *
 * `applyClearBatch` 不用它：其中 `cleared_at IS NULL` 是「只清理仍未清理的项」
 * 这个业务条件的一部分，与可读基准的语义不同。
 */
const VISIBLE_UNCLEARED_RECEIPT = `${VISIBLE_CONTENT} AND r.cleared_at IS NULL`

export class NotificationRepository {
  constructor(readonly db: AppDatabase) {}

  /**
   * 锁住用户行并返回**是否仍活跃**。
   *
   * 存在性不等于活跃：发布之后、投影之前被停用的账号不能再收到通知，
   * 否则 `skipped_disabled` 只会在账号行被删除时出现。
   *
   * 只有 `projection.ts` 消费「活跃」这个判定。`service.ts` 的六处调用只用它取行锁、
   * 不看返回值 —— 停用账号在会话解析处就被拒了（`auth/service.ts` 校验 `disabled_at`），
   * 根本进不到通知的 service 路径。`FOR NO KEY UPDATE` 无论活跃与否都会取到锁。
   */
  async lockUser(userId: string, executor: SqlExecutor = this.db): Promise<boolean> {
    const result = await executor.query<{ id: string; disabled_at: number | null }>(
      'SELECT id, disabled_at FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [userId])
    const row = result.rows[0]
    return row !== undefined && row.disabled_at === null
  }

  async lockStream(userId: string, executor: SqlExecutor): Promise<{ lastSequence: number; stateVersion: number }> {
    await executor.query(
      `INSERT INTO notification_user_streams (user_id, last_sequence, state_version) VALUES ($1, 0, 0)
        ON CONFLICT (user_id) DO NOTHING`, [userId])
    const result = await executor.query<{ last_sequence: number; state_version: number }>(
      'SELECT last_sequence, state_version FROM notification_user_streams WHERE user_id = $1 FOR UPDATE', [userId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('通知序列行缺失。')
    return { lastSequence: row.last_sequence, stateVersion: row.state_version }
  }

  async bumpStream(userId: string, executor: SqlExecutor, delta = 1): Promise<number> {
    const result = await executor.query<{ state_version: number }>(
      `UPDATE notification_user_streams SET state_version = state_version + $2 WHERE user_id = $1
        RETURNING state_version`, [userId, delta])
    return result.rows[0]?.state_version ?? 0
  }

  async insertEvent(row: NotificationEventRow, executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(`INSERT INTO notification_events (event_id, event_type, event_version, occurred_at,
      source_type, source_id, source_revision, scope, dedupe_key, digest, actor_user_id, data_json, content_id,
      projection_status, projection_attempts, projection_lease_owner, projection_lease_expires_at,
      projection_next_attempt_at, projection_completed_at, projection_error_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [row.event_id, row.event_type, row.event_version, row.occurred_at, row.source_type, row.source_id,
      row.source_revision, row.scope, row.dedupe_key, row.digest, row.actor_user_id, row.data_json,
      row.content_id, row.projection_status, row.projection_attempts, row.projection_lease_owner,
      row.projection_lease_expires_at, row.projection_next_attempt_at, row.projection_completed_at,
      row.projection_error_code])
  }

  async findEventByDedupeKey(dedupeKey: string, executor: SqlExecutor = this.db): Promise<NotificationEventRow | undefined> {
    const result = await executor.query<NotificationEventRow>(
      'SELECT * FROM notification_events WHERE dedupe_key = $1', [dedupeKey])
    return result.rows[0]
  }

  async insertContent(row: NotificationContentRow, executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(`INSERT INTO notification_contents (content_id, title, format, schema_version,
      policy_version, html, text, summary_text, content_revision, template_id, template_version, source_revision,
      scope, category, necessity, actions_json, available_at, expires_at, withdrawn_at, actor_user_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [row.content_id, row.title, row.format, row.schema_version, row.policy_version, row.html, row.text,
      row.summary_text, row.content_revision, row.template_id, row.template_version, row.source_revision,
      row.scope, row.category, row.necessity, row.actions_json, row.available_at, row.expires_at,
      row.withdrawn_at, row.actor_user_id, row.created_at])
  }

  async insertRecipients(eventId: string, userIds: readonly string[], executor: SqlExecutor = this.db): Promise<number> {
    if (userIds.length === 0) return 0
    const values: unknown[] = []
    const placeholders = userIds.map((userId, index) => {
      values.push(eventId, userId)
      return `($${index * 2 + 1}, $${index * 2 + 2}, 'pending')`
    })
    const result = await executor.query(
      `INSERT INTO notification_event_recipients (event_id, user_id, state) VALUES ${placeholders.join(', ')}
        ON CONFLICT (event_id, user_id) DO NOTHING`, values)
    return result.rowCount ?? 0
  }

  async claimDueEvents(limit: number, now: number, leaseOwner: string, leaseMs: number,
    executor: SqlExecutor = this.db): Promise<NotificationEventRow[]> {
    const result = await executor.query<NotificationEventRow>(`
      UPDATE notification_events SET projection_lease_owner = $3,
          projection_lease_expires_at = $4
        WHERE event_id IN (
          SELECT event_id FROM notification_events
            WHERE projection_status IN ('pending', 'failed')
              AND projection_next_attempt_at <= $2
              AND (projection_lease_expires_at IS NULL OR projection_lease_expires_at <= $2)
            ORDER BY projection_next_attempt_at, event_id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
        )
        RETURNING *`, [limit, now, leaseOwner, now + leaseMs])
    return result.rows
  }

  async pendingRecipients(eventId: string, limit: number, executor: SqlExecutor = this.db): Promise<string[]> {
    const result = await executor.query<{ user_id: string }>(
      `SELECT user_id FROM notification_event_recipients
        WHERE event_id = $1 AND state = 'pending' ORDER BY user_id LIMIT $2`, [eventId, limit])
    return result.rows.map(row => row.user_id)
  }

  async markRecipient(eventId: string, userId: string, state: string, receiptId: string | null,
    now: number, executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(
      `UPDATE notification_event_recipients SET state = $3, decided_at = $4, receipt_id = $5
        WHERE event_id = $1 AND user_id = $2`, [eventId, userId, state, now, receiptId])
  }

  async completeEventProjection(eventId: string, now: number, executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(
      `UPDATE notification_events SET projection_status = 'completed', projection_completed_at = $2,
        projection_lease_owner = NULL, projection_lease_expires_at = NULL, projection_error_code = NULL
        WHERE event_id = $1`, [eventId, now])
  }

  async failEventProjection(eventId: string, now: number, attempts: number, errorCode: string,
    nextDelayMs: number, executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(
      `UPDATE notification_events SET projection_status = CASE WHEN $3 >= 8 THEN 'failed'::text ELSE 'pending'::text END,
        projection_attempts = $3, projection_error_code = $4, projection_next_attempt_at = $5,
        projection_lease_owner = NULL, projection_lease_expires_at = NULL
        WHERE event_id = $1`, [eventId, now, attempts, errorCode, now + nextDelayMs])
  }

  /**
   * 内容尚未生效：释放 lease 并把下次时间推到生效时刻，不消耗失败预算。
   * 否则 worker 会在每一轮重复认领同一事件，形成空转。
   */
  async deferEventProjection(eventId: string, nextAttemptAt: number,
    executor: SqlExecutor = this.db): Promise<void> {
    await executor.query(
      `UPDATE notification_events SET projection_next_attempt_at = $2,
        projection_lease_owner = NULL, projection_lease_expires_at = NULL
        WHERE event_id = $1`, [eventId, nextAttemptAt])
  }

  async withdrawContent(contentId: string, now: number, executor: SqlExecutor = this.db): Promise<number> {
    const result = await executor.query(
      `UPDATE notification_contents SET withdrawn_at = $2 WHERE content_id = $1 AND withdrawn_at IS NULL`,
      [contentId, now])
    return result.rowCount ?? 0
  }

  async findContent(contentId: string, executor: SqlExecutor = this.db): Promise<NotificationContentRow | undefined> {
    const result = await executor.query<NotificationContentRow>(
      'SELECT * FROM notification_contents WHERE content_id = $1', [contentId])
    return result.rows[0]
  }

  async findReceipt(receiptId: string, userId: string, now: number,
    executor: SqlExecutor = this.db): Promise<ReceiptListRow | undefined> {
    const result = await executor.query<ReceiptListRow>(
      `${RECEIPT_SELECT} WHERE r.receipt_id = $3 AND ${VISIBLE_UNCLEARED_RECEIPT}`, [userId, now, receiptId])
    return result.rows[0]
  }

  async findReceiptForUpdate(receiptId: string, userId: string, now: number,
    executor: SqlExecutor): Promise<ReceiptListRow | undefined> {
    const result = await executor.query<ReceiptListRow>(
      `${RECEIPT_SELECT} WHERE r.receipt_id = $3 AND ${VISIBLE_UNCLEARED_RECEIPT} FOR UPDATE OF r`,
      [userId, now, receiptId])
    return result.rows[0]
  }

  /** `view=unread` 与 `view=history` 共用同一套谓词，只在未读条件上分叉。 */
  async listReceipts(params: {
    userId: string
    now: number
    view: 'unread' | 'history'
    scope: NotificationScope | null
    category: NotificationCategory | null
    limit: number
    afterSequence: number | null
    upperSequence: number
  }, executor: SqlExecutor = this.db): Promise<ReceiptListRow[]> {
    const values: unknown[] = [params.userId, params.now, params.upperSequence]
    let sql = `${RECEIPT_SELECT} WHERE ${VISIBLE_UNCLEARED_RECEIPT} AND r.sequence <= $3`
    if (params.view === 'unread') {
      sql += ' AND r.read_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > $2)'
    }
    if (params.scope !== null) {
      values.push(params.scope)
      sql += ` AND r.scope = $${values.length}`
    }
    if (params.category !== null) {
      values.push(params.category)
      sql += ` AND c.category = $${values.length}`
    }
    if (params.afterSequence !== null) {
      values.push(params.afterSequence)
      sql += ` AND r.sequence < $${values.length}`
    }
    values.push(params.limit)
    sql += ` ORDER BY r.sequence DESC LIMIT $${values.length}`
    const result = await executor.query<ReceiptListRow>(sql, values)
    return result.rows
  }

  async countUnread(userId: string, now: number, executor: SqlExecutor = this.db): Promise<number> {
    const result = await executor.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM notification_receipts r
        JOIN notification_contents c ON c.content_id = r.content_id
        WHERE ${VISIBLE_UNCLEARED_RECEIPT} AND r.read_at IS NULL
          AND (c.expires_at IS NULL OR c.expires_at > $2)`, [userId, now])
    return Number(result.rows[0]?.count ?? 0)
  }

  async upperSequence(userId: string, executor: SqlExecutor = this.db): Promise<number> {
    const result = await executor.query<{ last_sequence: number }>(
      'SELECT last_sequence FROM notification_user_streams WHERE user_id = $1', [userId])
    return result.rows[0]?.last_sequence ?? 0
  }

  async setStateRevision(receiptId: string, userId: string, read: boolean, expectedRevision: number,
    now: number, executor: SqlExecutor): Promise<number | null> {
    const result = await executor.query<{ state_revision: number }>(`
      UPDATE notification_receipts SET read_at = CASE WHEN $4 THEN COALESCE(read_at, $5) ELSE NULL END,
          state_revision = state_revision + 1
        WHERE receipt_id = $1 AND user_id = $2 AND state_revision = $3
          AND (($4 AND read_at IS NULL) OR (NOT $4 AND read_at IS NOT NULL))
        RETURNING state_revision`, [receiptId, userId, expectedRevision, read, now])
    return result.rows[0]?.state_revision ?? null
  }

  /** 只改上界内当前仍满足未读谓词的 receipt；已清理与已读项不重写。 */
  async markReadThrough(userId: string, now: number, upperSequence: number, executor: SqlExecutor): Promise<number> {
    const result = await executor.query(`
      UPDATE notification_receipts r SET read_at = $2, state_revision = state_revision + 1
        FROM notification_contents c
        WHERE c.content_id = r.content_id AND r.user_id = $1 AND ${VISIBLE_UNCLEARED_RECEIPT}
          AND r.read_at IS NULL AND r.sequence <= $3
          AND (c.expires_at IS NULL OR c.expires_at > $2)`, [userId, now, upperSequence])
    return result.rowCount ?? 0
  }

  async insertReceipt(receipt: {
    receiptId: string
    userId: string
    contentId: string
    eventId: string
    sequence: number
    scope: NotificationScope
    deliveredAt: number
  }, executor: SqlExecutor): Promise<void> {
    await executor.query(`INSERT INTO notification_receipts (receipt_id, user_id, content_id, event_id,
      sequence, scope, delivered_at, clear_revision, state_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,0,0)`,
    [receipt.receiptId, receipt.userId, receipt.contentId, receipt.eventId, receipt.sequence,
      receipt.scope, receipt.deliveredAt])
  }

  async insertMutation(row: {
    userId: string
    requestId: string
    kind: 'read_through' | 'clear'
    digest: string
    resultJson: string
    clearBatchId: string | null
    createdAt: number
  }, executor: SqlExecutor = this.db): Promise<boolean> {
    const result = await executor.query(
      `INSERT INTO notification_mutations (user_id, request_id, kind, digest, result_json, clear_batch_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, request_id) DO NOTHING`,
      [row.userId, row.requestId, row.kind, row.digest, row.resultJson, row.clearBatchId, row.createdAt])
    return (result.rowCount ?? 0) === 1
  }

  /**
   * 按 `(user_id, request_id)` 查重放记录 —— 这正是表的**主键**。
   *
   * 不能按 `(user_id, request_id, kind)` 查：跨 kind 复用同一个 requestId 时查不到记录，
   * 命令会重复执行，而随后的 `ON CONFLICT DO NOTHING` 又会静默丢掉去重记录。
   * 这里一律把记录取回来，由调用方判定 kind 是否匹配并给出明确冲突。
   */
  async findMutation(userId: string, requestId: string,
    executor: SqlExecutor = this.db): Promise<{ kind: string; digest: string; result_json: string } | undefined> {
    const result = await executor.query<{ kind: string; digest: string; result_json: string }>(
      'SELECT kind, digest, result_json FROM notification_mutations WHERE user_id = $1 AND request_id = $2',
      [userId, requestId])
    return result.rows[0]
  }

  /**
   * 清掉本人**已经无法提交**的 preview 批次，连带它们的 items。
   *
   * preview 批次的 token 与 `preview_expires_at` 同时到期：过了这个时刻 `verifyToken` 先抛
   * `NOTIFICATION_TOKEN_EXPIRED`，批次行再也不会被任何请求读到，只是留在表里累积。
   * 每次新建预览时顺手扫掉这些死行，写入侧就不再随点开次数线性增长。
   *
   * 这里**只**删过期项，不删仍在有效期内的 preview：设计 9.2 要求并发/先后两份预览各自独立，
   * 旧预览要能提交并对已变化的项记 skipped，把在途预览合并或换掉会破坏这条语义。
   * 已 applied / 历史 restored 的批次是执行事实，不在这条删除范围内。
   */
  async discardExpiredPreviewBatches(userId: string, now: number, executor: SqlExecutor): Promise<number> {
    // items 对 batches 是 ON DELETE RESTRICT，必须先删子表。
    await executor.query(`DELETE FROM notification_clear_batch_items WHERE batch_id IN
      (SELECT batch_id FROM notification_clear_batches
        WHERE user_id = $1 AND status = 'preview' AND preview_expires_at < $2)`, [userId, now])
    const result = await executor.query(
      `DELETE FROM notification_clear_batches
        WHERE user_id = $1 AND status = 'preview' AND preview_expires_at < $2`, [userId, now])
    return result.rowCount ?? 0
  }

  async insertClearBatch(row: ClearBatchRow, receiptIds: readonly { receiptId: string; clearRevision: number }[],
    executor: SqlExecutor): Promise<void> {
    await executor.query(`INSERT INTO notification_clear_batches (batch_id, user_id, snapshot_id, upper_sequence,
      preview_expires_at, status, request_id, item_count, affected_count, skipped_count, created_at, applied_at, restored_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.batch_id, row.user_id, row.snapshot_id, row.upper_sequence, row.preview_expires_at, row.status,
      row.request_id, row.item_count, row.affected_count, row.skipped_count, row.created_at, row.applied_at,
      row.restored_at])
    // 一次 unnest 写入整页：快照可以很大，逐条 INSERT 会把它变成 N 次往返，
    // 而且整段都跑在已持有 user/stream 行锁的事务里。
    await executor.query(`INSERT INTO notification_clear_batch_items (batch_id, receipt_id, expected_clear_revision)
      SELECT $1, t.receipt_id, t.expected_clear_revision
        FROM unnest($2::text[], $3::int[]) AS t(receipt_id, expected_clear_revision)`,
    [row.batch_id, receiptIds.map(item => item.receiptId), receiptIds.map(item => item.clearRevision)])
  }

  async findClearBatchForUpdate(batchId: string, userId: string, executor: SqlExecutor): Promise<ClearBatchRow | undefined> {
    const result = await executor.query<ClearBatchRow>(
      'SELECT * FROM notification_clear_batches WHERE batch_id = $1 AND user_id = $2 FOR UPDATE', [batchId, userId])
    return result.rows[0]
  }

  /**
   * 只清理该 batch 精确集合内、仍属于本人、仍可见、仍未清理且 clearRevision
   * 仍与预览一致的 receipt。晚到的 fanout 与已被别的设备清理或 clear revision 已变化的项被跳过。
   */
  async applyClearBatch(batchId: string, userId: string, now: number, executor: SqlExecutor): Promise<{ affected: number; skipped: number }> {
    const items = await executor.query<{ receipt_id: string; expected_clear_revision: number }>(
      'SELECT receipt_id, expected_clear_revision FROM notification_clear_batch_items WHERE batch_id = $1', [batchId])
    let affected = 0
    let skipped = 0
    for (const item of items.rows) {
      const result = await executor.query(`
        UPDATE notification_receipts r SET cleared_at = $3, clear_batch_id = $4, clear_revision = clear_revision + 1,
            state_revision = state_revision + 1
          FROM notification_contents c
          WHERE c.content_id = r.content_id AND r.receipt_id = $1 AND r.user_id = $2 AND r.cleared_at IS NULL
            AND r.clear_revision = $5 AND c.available_at <= $3 AND c.withdrawn_at IS NULL`,
      [item.receipt_id, userId, now, batchId, item.expected_clear_revision])
      if ((result.rowCount ?? 0) === 1) {
        affected += 1
        await executor.query(
          'UPDATE notification_clear_batch_items SET applied_clear_revision = $3 WHERE batch_id = $1 AND receipt_id = $2',
          [batchId, item.receipt_id, item.expected_clear_revision + 1])
      } else {
        skipped += 1
      }
    }
    return { affected, skipped }
  }

  async unclearedSnapshot(userId: string, now: number,
    executor: SqlExecutor = this.db): Promise<Array<{ receiptId: string; clearRevision: number }>> {
    const result = await executor.query<{ receipt_id: string; clear_revision: number }>(`
      SELECT r.receipt_id, r.clear_revision FROM notification_receipts r
        JOIN notification_contents c ON c.content_id = r.content_id
        WHERE ${VISIBLE_UNCLEARED_RECEIPT}
        ORDER BY r.sequence DESC`, [userId, now])
    return result.rows.map(row => ({ receiptId: row.receipt_id, clearRevision: row.clear_revision }))
  }

  async getPreferences(userId: string, executor: SqlExecutor = this.db): Promise<
    { announcementEnabled: boolean; personalUpdateEnabled: boolean; revision: number } | undefined> {
    const result = await executor.query<{ announcement_enabled: boolean; personal_update_enabled: boolean; revision: number }>(
      `SELECT announcement_enabled, personal_update_enabled, revision FROM notification_preferences WHERE user_id = $1`,
      [userId])
    const row = result.rows[0]
    if (row === undefined) return undefined
    return {
      announcementEnabled: row.announcement_enabled,
      personalUpdateEnabled: row.personal_update_enabled,
      revision: row.revision,
    }
  }

  async savePreferences(userId: string, input: { announcementEnabled: boolean; personalUpdateEnabled: boolean },
    expectedRevision: number, now: number, executor: SqlExecutor = this.db): Promise<number | null> {
    const result = await executor.query<{ revision: number }>(`
      INSERT INTO notification_preferences (user_id, announcement_enabled, personal_update_enabled, revision, updated_at)
        VALUES ($1, $2, $3, $4, $6)
        ON CONFLICT (user_id) DO UPDATE SET announcement_enabled = $2, personal_update_enabled = $3,
          revision = notification_preferences.revision + 1, updated_at = $6
          WHERE notification_preferences.revision = $5
        RETURNING revision`,
    [userId, input.announcementEnabled, input.personalUpdateEnabled, 1, expectedRevision, now])
    return result.rows[0]?.revision ?? null
  }

  async activeUserIds(limit: number, executor: SqlExecutor = this.db): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      'SELECT id FROM auth_users WHERE disabled_at IS NULL ORDER BY id LIMIT $1', [limit])
    return result.rows.map(row => row.id)
  }

  async usersExist(userIds: readonly string[], executor: SqlExecutor = this.db): Promise<Set<string>> {
    if (userIds.length === 0) return new Set()
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM auth_users WHERE id = ANY($1::text[]) AND disabled_at IS NULL`, [[...userIds]])
    return new Set(result.rows.map(row => row.id))
  }

  /** Result-event snapshots retain disabled applicants; ordinary audience selection remains active-only. */
  async existingUserIds(userIds: readonly string[], executor: SqlExecutor): Promise<Set<string>> {
    const result = await executor.query<{ id: string }>('SELECT id FROM auth_users WHERE id = ANY($1::text[])', [[...userIds]])
    return new Set(result.rows.map(row => row.id))
  }

  async isAdminUser(userId: string, executor: SqlExecutor = this.db): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM community_group_memberships WHERE user_id = $1 AND group_code = 'admin'`, [userId])
    return result.rows.length === 1
  }
}
