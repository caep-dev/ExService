import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createApp, serviceHandlers } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import Ajv, { type ValidateFunction } from 'ajv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readContract as readDocument } from '@tests/helpers/contract'

/**
 * 真实 Fastify HTTP + 原始 handler 输出的 Contract 校验。
 *
 * 只读 `api/generated/openapi.json`，不在测试里复制响应结构；同时校验 handler 的
 * 原始返回值，因为 Fastify 会用 response schema 序列化，未声明字段会被静默丢弃。
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contractPath = resolve(projectRoot, 'api/generated/openapi.json')

interface ContractDocument {
  schemas: Record<string, unknown>
}

function readContract(): ContractDocument {
  const parsed = readDocument(contractPath) as { components?: { schemas?: unknown } }
  const schemas = parsed.components?.schemas
  if (typeof schemas !== 'object' || schemas === null) {
    throw new Error(`api/generated/openapi.json 缺少 components.schemas：${contractPath}`)
  }
  return { schemas: schemas as Record<string, unknown> }
}

const contract = readContract()
const definitions = JSON.parse(
  JSON.stringify(contract.schemas).replaceAll('#/components/schemas/', '#/definitions/'),
) as Record<string, unknown>

function compile(name: string): ValidateFunction {
  const schema = definitions[name]
  if (typeof schema !== 'object' || schema === null) throw new Error(`缺少 components.schemas.${name}`)
  return new Ajv({ allErrors: true, strict: false }).compile({ ...(schema as Record<string, unknown>), definitions })
}

const validators = {
  list: compile('NotificationList'),
  summary: compile('NotificationSummary'),
  detail: compile('NotificationDetail'),
  state: compile('NotificationState'),
  readAll: compile('NotificationReadAllResult'),
  preview: compile('NotificationClearPreview'),
  clear: compile('NotificationClearResult'),
  preferences: compile('NotificationPreferences'),
  error: compile('ErrorEnvelope'),
}

const RICH_HTML = '<h2>维护窗口</h2><p>本周六 02:00 起维护，详见 <a href="/communities/caep">CAEP 社区</a>。</p>' +
  '<ul><li>影响：登录</li><li>影响：文档</li></ul>'

const apps: Array<ReturnType<typeof createApp>> = []
const fixtures: TestAuth[] = []

// 每条用例都新建一个隔离 PostgreSQL schema（Testcontainers），全量并行时首轮迁移可能超过默认 hook 超时。
const HOOK_TIMEOUT = 120_000

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
}, HOOK_TIMEOUT)

let fixture: TestAuth
let app: ReturnType<typeof createApp>
let authorization: string
let userId: string
let otherAuthorization: string

beforeEach(async () => {
  fixture = await createTestAuth()
  fixtures.push(fixture)
  app = createApp({ ...fixture,
    authServices: fixture.authServices, profileServices: fixture.profileServices,
    storageServices: fixture.storageServices, notifications: fixture.notifications, clickupServices: fixture.clickupServices, supportServices: fixture.supportServices })
  await app.ready()
  apps.push(app)

  userId = await fixture.seedUser({ email: 'reader@example.com', nickname: 'Reader', password: 'valid password' })
  const session = await fixture.authServices.login({ email: 'reader@example.com', password: 'valid password' })
  authorization = `Bearer ${session.token}`

  await fixture.seedUser({ email: 'other@example.com', nickname: 'Other', password: 'valid password' })
  const other = await fixture.authServices.login({ email: 'other@example.com', password: 'valid password' })
  otherAuthorization = `Bearer ${other.token}`
}, HOOK_TIMEOUT)

async function publish(title: string, audienceUserIds: readonly string[] = 'all' as unknown as string[]): Promise<void> {
  await fixture.notifications.producer.publish({
    eventType: 'community.announcement.published',
    dedupeKey: `${title}-${randomUUID()}`,
    actorUserId: null,
    audience: audienceUserIds === ('all' as unknown as string[])
      ? { kind: 'all_active_users' }
      : { kind: 'users', userIds: audienceUserIds },
    content: {
      title, html: RICH_HTML, templateId: 'community.announcement', templateVersion: 1,
      sourceRevision: 1, actionsJson: JSON.stringify([
        { kind: 'navigate', actionId: 'go', targetKey: 'community.home', emphasis: 'primary' },
      ]),
      availableAt: null, expiresAt: null,
    },
    sourceType: 'internal', sourceId: 'test',
  })
  for (let index = 0; index < 5; index += 1) {
    const round = await fixture.notifications.worker.runRound()
    if (round.eventsClaimed === 0) return
  }
}

async function legacyUnrenderableNotification(): Promise<string> {
  await publish('旧策略正文', [userId])
  const list = await fixture.notifications.service.list({ userId, view: 'history', scope: null, category: null, limit: null, cursor: null })
  const receiptId = list.items[0]!.receiptId
  // 当前策略逐次重新校验 HTML；隔离 schema 的旧字节携带不允许的属性，纯文本保留安全回退。
  await fixture.db.query(`UPDATE notification_contents SET html = $2, text = $3
    WHERE content_id = (SELECT content_id FROM notification_receipts WHERE receipt_id = $1)`,
  [receiptId, '<p onclick="legacyUnsafe()">旧正文</p>', '旧正文：安全的纯文本回退'])
  return receiptId
}

describe('notification contract over HTTP', () => {
  it('falls back to safe text over HTTP when legacy content cannot satisfy the current policy', async () => {
    const receiptId = await legacyUnrenderableNotification()
    const response = await app.inject({ method: 'GET', url: `/api/notifications/${receiptId}`, headers: { authorization } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const detail = response.json()
    expect(validators.detail(detail), JSON.stringify(validators.detail.errors)).toBe(true)
    expect(detail.content).toBeNull()
    expect(detail.contentAvailable).toBe(false)
    expect(detail.contentFallbackText).toBe('旧正文：安全的纯文本回退')
    expect(detail.contentFallbackText).not.toMatch(/<|onclick|legacyUnsafe/)
  })

  it('lists, summarizes and reads the authenticated user own notifications', async () => {
    await publish('第一条', [userId])

    const list = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.headers['cache-control']).toBe('no-store')
    expect(validators.list(list.json())).toBe(true)

    const summary = await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { authorization } })
    expect(summary.statusCode).toBe(200)
    expect(validators.summary(summary.json())).toBe(true)
    expect((summary.json() as { unreadCount: number }).unreadCount).toBe(1)

    const receiptId = (list.json() as { items: Array<{ receiptId: string }> }).items[0]!.receiptId
    const detail = await app.inject({ method: 'GET', url: `/api/notifications/${receiptId}`, headers: { authorization } })
    expect(detail.statusCode, detail.body).toBe(200)
    expect(validators.detail(detail.json())).toBe(true)
    const body = detail.json() as { contentAvailable: boolean; actionsAvailable: boolean; lifecycle: string }
    expect(body.contentAvailable).toBe(true)
    expect(body.actionsAvailable).toBe(true)
    expect(body.lifecycle).toBe('active')
  })

  it('never returns notification bodies in the list', async () => {
    await publish('无正文', [userId])
    const list = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    const item = (list.json() as { items: Array<Record<string, unknown>> }).items[0]!
    expect(Object.keys(item).sort()).toEqual(['category', 'deliveredAt', 'expired', 'necessity', 'readAt',
      'receiptId', 'scope', 'sequence', 'stateRevision', 'summaryText', 'title'])
  })

  it('separates unread and history without writing state', async () => {
    await publish('已读测试', [userId])
    const before = await app.inject({ method: 'GET', url: '/api/notifications?view=unread', headers: { authorization } })
    const receiptId = (before.json() as { items: Array<{ receiptId: string }> }).items[0]!.receiptId
    await app.inject({ method: 'GET', url: `/api/notifications/${receiptId}`, headers: { authorization } })
    const after = await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { authorization } })
    // 打开详情不写状态：GET 是只读的。
    expect((after.json() as { unreadCount: number }).unreadCount).toBe(1)

    const marked = await app.inject({ method: 'PATCH', url: `/api/notifications/${receiptId}/state`,
      headers: { authorization }, payload: { read: true, expectedRevision: 0 } })
    expect(marked.statusCode).toBe(200)
    expect(validators.state(marked.json())).toBe(true)
    const unread = await app.inject({ method: 'GET', url: '/api/notifications?view=unread', headers: { authorization } })
    expect((unread.json() as { items: unknown[] }).items).toHaveLength(0)
    const history = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    expect((history.json() as { items: unknown[] }).items).toHaveLength(1)
  })

  it('runs the read-through, clear preview and clear flow', async () => {
    await publish('一', [userId])
    await publish('二', [userId])

    const summary = await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { authorization } })
    const readAll = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization },
      payload: { requestId: randomUUID(), readThroughToken: (summary.json() as { readThroughToken: string }).readThroughToken } })
    expect(readAll.statusCode, readAll.body).toBe(200)
    expect(validators.readAll(readAll.json())).toBe(true)
    expect((readAll.json() as { affectedCount: number }).affectedCount).toBe(2)

    const preview = await app.inject({ method: 'POST', url: '/api/notifications/clear-preview',
      headers: { authorization }, payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(validators.preview(preview.json())).toBe(true)
    const { clearSnapshotToken } = preview.json() as { clearSnapshotToken: string }

    const cleared = await app.inject({ method: 'POST', url: '/api/notifications/clear-all', headers: { authorization },
      payload: { requestId: randomUUID(), clearSnapshotToken } })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(validators.clear(cleared.json())).toBe(true)

    const history = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    expect((history.json() as { items: unknown[] }).items).toHaveLength(0)
  })

  it('reads and replaces notification preferences', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/notification-preferences', headers: { authorization } })
    expect(initial.statusCode).toBe(200)
    expect(validators.preferences(initial.json())).toBe(true)
    expect((initial.json() as { revision: number }).revision).toBe(0)

    const updated = await app.inject({ method: 'PUT', url: '/api/notification-preferences',
      headers: { authorization }, payload: { expectedRevision: 0,
        optionalCategories: { announcement: false, personal_update: true } } })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(validators.preferences(updated.json())).toBe(true)
    expect((updated.json() as { revision: number }).revision).toBe(1)

    const stale = await app.inject({ method: 'PUT', url: '/api/notification-preferences',
      headers: { authorization }, payload: { expectedRevision: 0,
        optionalCategories: { announcement: true, personal_update: true } } })
    expect(stale.statusCode).toBe(409)
    expect(validators.error(stale.json())).toBe(true)
  })

  it('rejects unauthenticated reads and never serves another user receipt', async () => {
    await publish('私人', [userId])

    const anonymous = await app.inject({ method: 'GET', url: '/api/notifications?view=history' })
    expect(anonymous.statusCode).toBe(401)
    expect(validators.error(anonymous.json())).toBe(true)

    const mine = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    const receiptId = (mine.json() as { items: Array<{ receiptId: string }> }).items[0]!.receiptId
    const foreign = await app.inject({ method: 'GET', url: `/api/notifications/${receiptId}`, headers: { authorization: otherAuthorization } })
    expect(foreign.statusCode).toBe(404)
    // 越权返回中性 404：不泄露标题或正文。
    expect(foreign.body).not.toContain('私人')
    expect(foreign.body).not.toContain('维护窗口')
  })

  it('rejects a closed-field violation with the contract envelope', async () => {
    const rejected = await app.inject({ method: 'PATCH', url: `/api/notifications/${randomUUID()}/state`,
      headers: { authorization }, payload: { read: true, expectedRevision: 0, archived: true } })
    expect(rejected.statusCode).toBe(400)
    expect(validators.error(rejected.json())).toBe(true)
  })

  it('rejects an unknown enum value and a limit outside the closed range', async () => {
    const badView = await app.inject({ method: 'GET', url: '/api/notifications?view=archived', headers: { authorization } })
    expect(badView.statusCode).toBe(400)
    const badLimit = await app.inject({ method: 'GET', url: '/api/notifications?view=history&limit=500', headers: { authorization } })
    expect(badLimit.statusCode).toBe(400)
    const missingView = await app.inject({ method: 'GET', url: '/api/notifications', headers: { authorization } })
    expect(missingView.statusCode).toBe(400)
  })

  it('accepts every legal limit on the notification list', async () => {
    // 反向对照：越界 limit 仍必须 400，否则「合法 limit 全绿」可能只是校验被整体跳过。
    await publish('甲', [userId])
    await publish('乙', [userId])

    for (const limit of [1, 20, 50]) {
      const page = await app.inject({ method: 'GET', url: `/api/notifications?view=history&limit=${limit}`,
        headers: { authorization } })
      expect(page.statusCode, `limit=${limit}: ${page.body}`).toBe(200)
      expect(validators.list(page.json())).toBe(true)
    }

    // limit 真的传到了 service，而不是被忽略后按默认 20 返回全部。
    const first = await app.inject({ method: 'GET', url: '/api/notifications?view=history&limit=1',
      headers: { authorization } })
    const firstItems = (first.json() as { items: Array<{ receiptId: string }>; nextCursor: string | null }).items
    expect(firstItems).toHaveLength(1)
    const cursor = (first.json() as { nextCursor: string | null }).nextCursor
    expect(cursor).not.toBeNull()
    const second = await app.inject({ method: 'GET',
      url: `/api/notifications?view=history&limit=1&cursor=${encodeURIComponent(String(cursor))}`,
      headers: { authorization } })
    expect(second.statusCode, second.body).toBe(200)
    const secondItems = (second.json() as { items: Array<{ receiptId: string }> }).items
    expect(secondItems).toHaveLength(1)
    expect(secondItems[0]!.receiptId).not.toBe(firstItems[0]!.receiptId)
  })

  it('rejects a non-UUID notification id before touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notifications/not-a-uuid', headers: { authorization } })
    expect(response.statusCode).toBe(400)
    expect(validators.error(response.json())).toBe(true)
  })

  it('offers no clear-batch listing or restore capability after clearing', async () => {
    await publish('Non-restorable', [userId])
    const preview = await app.inject({ method: 'POST', url: '/api/notifications/clear-preview',
      headers: { authorization }, payload: {} })
    const { batchId, clearSnapshotToken } = preview.json() as { batchId: string; clearSnapshotToken: string }
    const clear = await app.inject({ method: 'POST', url: '/api/notifications/clear-all',
      headers: { authorization }, payload: { requestId: randomUUID(), clearSnapshotToken } })
    expect(clear.statusCode, clear.body).toBe(200)
    const batches = await app.inject({ method: 'GET', url: '/api/notifications/clear-batches',
      headers: { authorization } })
    expect([400, 404]).toContain(batches.statusCode)
    expect(validators.error(batches.json())).toBe(true)
    const restore = await app.inject({ method: 'POST', url: `/api/notifications/clear-batches/${batchId}/restore`,
      headers: { authorization }, payload: { requestId: randomUUID() } })
    expect(restore.statusCode).toBe(404)
    expect(validators.error(restore.json())).toBe(true)
    const history = await app.inject({ method: 'GET', url: '/api/notifications?view=history',
      headers: { authorization } })
    expect((history.json() as { items: unknown[] }).items).toHaveLength(0)
    expect(Object.keys(serviceHandlers)).not.toContain('listNotificationClearBatches')
    expect(Object.keys(serviceHandlers)).not.toContain('restoreNotificationClearBatch')
    const document = readDocument(contractPath) as {
      paths: Record<string, unknown>; components: { schemas: Record<string, unknown> }
    }
    expect(document.paths).not.toHaveProperty('/notifications/clear-batches')
    expect(document.paths).not.toHaveProperty('/notifications/clear-batches/{batchId}/restore')
    for (const schema of ['NotificationClearBatchItem', 'NotificationClearBatchList',
      'NotificationRestoreRequest', 'NotificationRestoreResult']) {
      expect(document.components.schemas).not.toHaveProperty(schema)
    }
  })

  it('registers no notification action execute endpoint', async () => {
    // N1 没有真实业务 adapter，因此不登记 execute operation。
    const response = await app.inject({ method: 'POST',
      url: `/api/notifications/${randomUUID()}/actions/join/execute`, headers: { authorization },
      payload: { requestId: randomUUID(), expectedBusinessVersion: 'v1' } })
    expect(response.statusCode).toBe(404)
    expect(Object.keys(serviceHandlers)).not.toContain('executeNotificationAction')
  })

  it('replays a repeated request id and refuses the same id with a different digest', async () => {
    await publish('一', [userId])
    await publish('二', [userId])
    const readThroughToken = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { authorization } })
      expect(response.statusCode).toBe(200)
      return (response.json() as { readThroughToken: string }).readThroughToken
    }

    const requestId = randomUUID()
    const first = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization },
      payload: { requestId, readThroughToken: await readThroughToken() } })
    expect(first.statusCode, first.body).toBe(200)
    expect(validators.readAll(first.json())).toBe(true)
    expect((first.json() as { affectedCount: number }).affectedCount).toBe(2)

    // 同 key 重放：返回原结果，不重新执行。
    const replay = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization },
      payload: { requestId, readThroughToken: await readThroughToken() } })
    expect(replay.statusCode).toBe(200)
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true)
    expect((replay.json() as { affectedCount: number }).affectedCount).toBe(2)

    // 同 key 换成另一份内容（新通知把上界推高了）：409，不是静默按新的执行。
    await publish('三', [userId])
    const conflict = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization },
      payload: { requestId, readThroughToken: await readThroughToken() } })
    expect(conflict.statusCode).toBe(409)
    expect(validators.error(conflict.json())).toBe(true)
  })

  it('refuses an expired clear token and never applies another user snapshot', async () => {
    await publish('私人', [userId])
    const preview = await app.inject({ method: 'POST', url: '/api/notifications/clear-preview',
      headers: { authorization }, payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    const { clearSnapshotToken } = preview.json() as { clearSnapshotToken: string }

    // 预览 token 绑定本人，不能用于其他账号。
    const foreign = await app.inject({ method: 'POST',
      url: '/api/notifications/clear-all', headers: { authorization: otherAuthorization },
      payload: { requestId: randomUUID(), clearSnapshotToken } })
    expect(foreign.statusCode).toBe(400)
    expect(validators.error(foreign.json())).toBe(true)

    // 预览 token 过了 10 分钟：410，由服务端时钟判定，不是按客户端时间推断。
    fixture.advance(11 * 60 * 1000)
    const expired = await app.inject({ method: 'POST', url: '/api/notifications/clear-all', headers: { authorization },
      payload: { requestId: randomUUID(), clearSnapshotToken } })
    expect(expired.statusCode).toBe(410)
    expect(validators.error(expired.json())).toBe(true)
  })

  it('marks a notification unread again', async () => {
    await publish('往返', [userId])
    const list = await app.inject({ method: 'GET', url: '/api/notifications?view=history', headers: { authorization } })
    const receiptId = (list.json() as { items: Array<{ receiptId: string }> }).items[0]!.receiptId

    const read = await app.inject({ method: 'PATCH', url: `/api/notifications/${receiptId}/state`,
      headers: { authorization }, payload: { read: true, expectedRevision: 0 } })
    expect(read.statusCode, read.body).toBe(200)
    const revision = (read.json() as { stateRevision: number }).stateRevision
    expect((read.json() as { unreadCount: number }).unreadCount).toBe(0)

    const unread = await app.inject({ method: 'PATCH', url: `/api/notifications/${receiptId}/state`,
      headers: { authorization }, payload: { read: false, expectedRevision: revision } })
    expect(unread.statusCode, unread.body).toBe(200)
    expect((unread.json() as { read: boolean; unreadCount: number }).read).toBe(false)
    expect((unread.json() as { unreadCount: number }).unreadCount).toBe(1)
  })

  it('never coerces the request body while the query string is coerced', async () => {
    await publish('正文', [userId])
    // 查询串的 `limit` 被强制成 integer，请求体里的 integer / string 一个都不强制：
    // 「数字 QQ 不得被转成字符串」这类已接受约束依赖 body 的 `coerceTypes: false`。
    const list = await app.inject({ method: 'GET', url: '/api/notifications?view=history&limit=20',
      headers: { authorization } })
    expect(list.statusCode).toBe(200)
    const receiptId = (list.json() as { items: Array<{ receiptId: string }> }).items[0]!.receiptId

    const stringRevision = await app.inject({ method: 'PATCH', url: `/api/notifications/${receiptId}/state`,
      headers: { authorization }, payload: { read: true, expectedRevision: '0' } })
    expect(stringRevision.statusCode).toBe(400)
    expect(validators.error(stringRevision.json())).toBe(true)

    const numberToken = await app.inject({ method: 'POST', url: '/api/notifications/read-all',
      headers: { authorization }, payload: { requestId: randomUUID(), readThroughToken: 42 } })
    expect(numberToken.statusCode).toBe(400)
    expect(validators.error(numberToken.json())).toBe(true)
  })
})

/**
 * 这一组是必需的：Fastify 会用 response schema 序列化，未声明字段被静默丢弃，
 * `const` 被强制写入，只断言 HTTP 响应发现不了 handler 回归。
 */
describe('registered notification handler output', () => {
  // handler 只调用 reply.header 设置 no-store，因此用最小桩直接校验原始返回值。
  const reply = { header: () => reply } as never

  it('falls back to safe text in raw handler output before serialization', async () => {
    const receiptId = await legacyUnrenderableNotification()
    const detail = await serviceHandlers.getNotification(
      { params: { notificationId: receiptId }, server: app, authSession: { userId } } as never, reply)
    expect(validators.detail(detail), JSON.stringify(validators.detail.errors)).toBe(true)
    expect(detail.content).toBeNull()
    expect(detail.contentAvailable).toBe(false)
    expect(detail.contentFallbackText).toBe('旧正文：安全的纯文本回退')
    expect(detail.contentFallbackText).not.toMatch(/<|onclick|legacyUnsafe/)
  })

  it('returns raw values that already satisfy the contract schemas', async () => {
    await publish('原始返回值', [userId])

    const list = await serviceHandlers.listNotifications(
      { query: { view: 'history' }, server: app, authSession: { userId } } as never, reply)
    expect(validators.list(list)).toBe(true)

    const summary = await serviceHandlers.getNotificationSummary(
      { server: app, authSession: { userId } } as never, reply)
    expect(validators.summary(summary)).toBe(true)

    const receiptId = (list as unknown as { items: Array<{ receiptId: string }> }).items[0]!.receiptId
    const detail = await serviceHandlers.getNotification(
      { params: { notificationId: receiptId }, server: app, authSession: { userId } } as never, reply)
    expect(validators.detail(detail)).toBe(true)

    const preferences = await serviceHandlers.getNotificationPreferences(
      { server: app, authSession: { userId } } as never, reply)
    expect(validators.preferences(preferences)).toBe(true)
  })

  it('exposes only the fields the contract declares', async () => {
    const summary = await serviceHandlers.getNotificationSummary(
      { server: app, authSession: { userId } } as never, reply) as Record<string, unknown>
    expect(Object.keys(summary).sort()).toEqual(['readThroughToken', 'serverTime', 'stateVersion', 'unreadCount', 'upperSequence'])
  })

  it('returns raw write results that already satisfy the contract schemas', async () => {
    // 直接验证写 operation 的原始返回值，防止序列化掩盖 handler 回归。
    await publish('一', [userId])
    await publish('二', [userId])
    const call = (handler: (...args: never[]) => unknown, request: Record<string, unknown>) =>
      handler({ server: app, authSession: { userId }, ...request } as never, reply)

    const list = await call(serviceHandlers.listNotifications, { query: { view: 'history' } }) as
      { items: Array<{ receiptId: string }> }
    const receiptId = list.items[0]!.receiptId

    const state = await call(serviceHandlers.updateNotificationState,
      { params: { notificationId: receiptId }, body: { read: true, expectedRevision: 0 } })
    expect(validators.state(state)).toBe(true)

    const summary = await call(serviceHandlers.getNotificationSummary, {}) as { readThroughToken: string }
    const readAll = await call(serviceHandlers.markNotificationsReadThrough,
      { body: { requestId: randomUUID(), readThroughToken: summary.readThroughToken } })
    expect(validators.readAll(readAll)).toBe(true)

    const preview = await call(serviceHandlers.previewNotificationClear, { body: {} }) as
      { batchId: string; clearSnapshotToken: string }
    expect(validators.preview(preview)).toBe(true)

    const clear = await call(serviceHandlers.clearNotificationsSnapshot,
      { body: { requestId: randomUUID(), clearSnapshotToken: preview.clearSnapshotToken } })
    expect(validators.clear(clear)).toBe(true)

    const preferences = await call(serviceHandlers.updateNotificationPreferences,
      { body: { expectedRevision: 0, optionalCategories: { announcement: false, personal_update: true } } })
    expect(validators.preferences(preferences)).toBe(true)
  })

  it('exposes only the fields the contract declares on the clear results', async () => {
    await publish('清理', [userId])
    const call = (handler: (...args: never[]) => unknown, request: Record<string, unknown>) =>
      handler({ server: app, authSession: { userId }, ...request } as never, reply)

    const preview = await call(serviceHandlers.previewNotificationClear, { body: {} }) as
      { batchId: string; clearSnapshotToken: string }
    expect(Object.keys(preview).sort()).toEqual(['batchId', 'clearSnapshotToken', 'expiresAt', 'itemCount',
      'serverTime', 'upperSequence'])

    const clear = await call(serviceHandlers.clearNotificationsSnapshot,
      { body: { requestId: randomUUID(), clearSnapshotToken: preview.clearSnapshotToken } }) as Record<string, unknown>
    expect(Object.keys(clear).sort()).toEqual(['affectedCount', 'batchId', 'replayed', 'requestId', 'serverTime',
      'skippedCount', 'unreadCount'])
  })

  /**
   * HTTP 层由 Contract 的 `enum` 先挡住；直接调用 handler 时走的是兜底分支。
   * 这条分支不能复用 `CONTENT_UNSAFE` —— 那条文案说的是「正文包含不受支持或不安全的内容」，
   * 用它回答一个非法查询参数会把排查方向带偏。
   */
  it('reports an illegal query value as a query error instead of unsafe content', async () => {
    const rejected = await serviceHandlers.listNotifications(
      { query: { view: 'history', scope: 'nope' }, server: app, authSession: { userId } } as never, reply
    ).then(() => null, (error: unknown) => error) as { code?: string; publicMessage?: string } | null
    expect(rejected).not.toBeNull()
    expect(rejected!.code).toBe('NOTIFICATION_QUERY_INVALID')
    expect(rejected!.publicMessage).not.toContain('正文')
  })
})
