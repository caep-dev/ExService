/**
 * 共享安全错误映射的回归门禁。
 *
 * `apps/server/src/errors.ts` 的映射被全部 operation 共用，multipart 上传的提前终结适配也走它。
 * 因此这里的黄金基线是在提取共用映射**之前**从真实 Fastify 应用采集的：状态、header、
 * envelope 字节、日志等级与字段都必须逐字节保持。
 *
 * 采集来源可审计：
 * - 提取前的 `apps/server/src/errors.ts` SHA256 = `39494853f64de114e89a4220939a0a2c30a78f4013318a53f8bc99c15c24bb52`（基线 `cf6a81a` / HEAD `8780b36`）。
 *   注意这是**工作区文件**（CRLF 换行）的哈希：同一内容的 git blob 是 `111c2b795182b61b69a9dcba688b5ec0e1d47933c7c550fd4fc365e8c29b44a8`，
 *   两者不是同一个数，`core.autocrlf=true` 下用 `git show … | sed 's/\$/\r/'` 才能复现前者；
 * - 采集产物（13 个场景的原始输出）随本 Issue 的复审交接附件保存为 `error-baseline-before.json`。
 *
 * 请求 ID 由测试侧确定性生成器固定（`createApp({ genReqId })`）：`requestIdHeader` 恒为 false，
 * 传入的 `x-request-id` 永不被采信，因此这里的整段字节比较不受外部输入影响。
 */
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import { AuthError } from '@server/src/modules/auth/errors'
import { StorageError } from '@server/src/modules/storage/errors'

const fixtures: TestAuth[] = []
const apps: ReturnType<typeof createApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

const REQUEST_ID_PLACEHOLDER = '{{requestId}}'
/** 测试侧固定请求 ID；`requestIdHeader: false` 保证它不来自客户端输入。 */
const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001'

interface GoldenScenario {
  name: string
  status: number
  headers: Record<string, string>
  body: string
  log?: { level: number; msg: string; code: string; statusCode: number }
}

/**
 * 提取前的实测输出（`error-baseline-before.json`）。
 * 修改 `errors.ts` 的映射语义时必须同步更新本表，并说明为什么既有 envelope 发生了变化。
 */
const GOLDEN: GoldenScenario[] = [
  {
    name: 'notFoundHandler-404',
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"NOT_FOUND","message":"The requested route is not part of the API contract.","requestId":"{{requestId}}"}}',
  },
  {
    name: 'contract-validation-400',
    status: 400,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"BAD_REQUEST","message":"body must have required property \'email\'","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'BAD_REQUEST', statusCode: 400 },
  },
  {
    name: 'publicError-401',
    status: 401,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"INVALID_CREDENTIALS","message":"邮箱或密码错误","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'INVALID_CREDENTIALS', statusCode: 401 },
  },
  {
    name: 'session-invalid-401',
    status: 401,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"SESSION_INVALID","message":"登录状态已失效，请重新登录","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'SESSION_INVALID', statusCode: 401 },
  },
  {
    name: 'business-404',
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"JOIN_ATTACHMENT_NOT_FOUND","message":"申请附件不存在。","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'JOIN_ATTACHMENT_NOT_FOUND', statusCode: 404 },
  },
  {
    name: 'unknown-500',
    status: 500,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred.","requestId":"{{requestId}}"}}',
    log: { level: 50, msg: 'request failed', code: 'INTERNAL_ERROR', statusCode: 500 },
  },
  {
    name: 'business-409',
    status: 409,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"JOIN_APPLICATION_EXISTS","message":"该邮箱已有申请，请查询申请结果。","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'JOIN_APPLICATION_EXISTS', statusCode: 409 },
  },
  {
    name: 'rate-limited-429-retry-after',
    status: 429,
    headers: { 'cache-control': 'no-store', 'retry-after': '7', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"JOIN_RATE_LIMITED","message":"请求过于频繁，请稍后重试","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'JOIN_RATE_LIMITED', statusCode: 429 },
  },
  {
    name: 'nested-errors-409',
    status: 409,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"JOIN_STATE_CONFLICT","message":"申请审核状态已发生变化，请刷新后重试","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'JOIN_STATE_CONFLICT', statusCode: 409 },
  },
  {
    name: 'declared-status-418',
    status: 418,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"BAD_REQUEST","message":"Fixed public text.","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'BAD_REQUEST', statusCode: 418 },
  },
  {
    name: 'storage-415',
    status: 415,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"STORAGE_UNSUPPORTED_MEDIA_TYPE","message":"不支持该请求或内容类型。","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'STORAGE_UNSUPPORTED_MEDIA_TYPE', statusCode: 415 },
  },
  {
    name: 'storage-413',
    status: 413,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"STORAGE_TOO_LARGE","message":"内容超过允许的大小。","requestId":"{{requestId}}"}}',
    log: { level: 40, msg: 'request rejected', code: 'STORAGE_TOO_LARGE', statusCode: 413 },
  },
  {
    name: 'storage-busy-503-retry-after',
    status: 503,
    headers: { 'cache-control': 'no-store', 'retry-after': '5', 'content-type': 'application/json; charset=utf-8' },
    body: '{"error":{"code":"STORAGE_BUSY","message":"上传服务繁忙，请稍后重试。","requestId":"{{requestId}}"}}',
    log: { level: 50, msg: 'request failed', code: 'STORAGE_BUSY', statusCode: 503 },
  },
]

/** 非上传 operation 的探针路由：只抛出既定错误，不参与 Contract 注册。 */
async function setup() {
  const f = await createTestAuth()
  fixtures.push(f)
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  // 测试侧确定性请求 ID：逐字节比较不受服务端自增计数或任何传入头影响。
  const app = createApp({ ...f, logger: { stream, level: 'warn' }, genReqId: () => FIXED_REQUEST_ID })
  apps.push(app)

  const probe = (url: string, error: unknown) => {
    app.route({ method: 'GET', url, handler: async () => { throw error } })
  }
  probe('/probe/unknown-500', new Error('secret postgres://user:pass@host/exre leaked'))
  probe('/probe/business-409', new AuthError('JOIN_APPLICATION_EXISTS'))
  probe('/probe/business-404', new AuthError('JOIN_ATTACHMENT_NOT_FOUND'))
  probe('/probe/rate-limited', new AuthError('JOIN_RATE_LIMITED', { retryAfterSeconds: 7 }))
  probe('/probe/nested-409', Object.assign(new Error('wrapper'), { errors: [new AuthError('JOIN_STATE_CONFLICT')] }))
  probe('/probe/declared-418', Object.assign(new Error('teapot'), { code: 'BAD_REQUEST', statusCode: 418, publicMessage: 'Fixed public text.' }))
  probe('/probe/storage-415', new StorageError('STORAGE_UNSUPPORTED_MEDIA_TYPE'))
  probe('/probe/storage-413', new StorageError('STORAGE_TOO_LARGE'))
  probe('/probe/storage-busy', new StorageError('STORAGE_BUSY', { retryAfterSeconds: 5 }))

  await f.seedUser({ email: 'mapping@example.com', nickname: 'Mapping', password: 'valid password' })
  await app.ready()
  return { f, app, lines }
}

async function runGolden(name: string, url: string, method: 'GET' | 'POST', payload?: unknown) {
  const { app, lines } = await setup()
  lines.length = 0
  const response = await app.inject({
    method, url, payload,
    // 请求 ID 由服务端确定性生成；传入的 x-request-id 不得被采信。
    headers: { 'x-request-id': 'forged-request-id' },
  })
  const requestId = response.headers['x-request-id']
  expect(requestId, name).toBe(FIXED_REQUEST_ID)
  // 传入的同名头不得被采信。
  expect(requestId).not.toBe('forged-request-id')
  const expected = GOLDEN.find(scenario => scenario.name === name)
  if (expected === undefined) throw new Error(`Missing golden scenario: ${name}`)

  expect(response.statusCode, name).toBe(expected.status)
  for (const [key, value] of Object.entries(expected.headers)) {
    expect(response.headers[key], `${name} header ${key}`).toBe(value)
  }
  // 整段字节比较：不解析 JSON，避免格式化差异掩盖 envelope 漂移。
  const body = response.body.split(requestId as string).join(REQUEST_ID_PLACEHOLDER)
  expect(body, name).toBe(expected.body)

  const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.reqId === requestId)
  expect(entries.length, `${name} log entries`).toBe(expected.log === undefined ? 0 : 1)
  if (expected.log !== undefined) {
    const entry = entries[0]!
    expect(entry.level, name).toBe(expected.log.level)
    expect(entry.msg, name).toBe(expected.log.msg)
    expect(entry.code, name).toBe(expected.log.code)
    expect(entry.statusCode, name).toBe(expected.log.statusCode)
    // 安全日志只含分类，不回显原始异常内容。
    expect(JSON.stringify(entry), name).not.toContain('postgres://')
  }
}

describe('shared safe error mapping', () => {
  it('keeps the not-found envelope byte-identical', () => runGolden('notFoundHandler-404', '/api/not-in-contract', 'GET'))

  it('keeps contract validation errors byte-identical', () => runGolden('contract-validation-400', '/api/auth/login', 'POST', {}))

  it('keeps public application errors byte-identical', () => runGolden('publicError-401', '/api/auth/login', 'POST', { email: 'mapping@example.com', password: 'wrong password' }))

  it('keeps the bearer session rejection byte-identical', () => runGolden('session-invalid-401', '/api/auth/me', 'GET'))

  it('keeps business not-found codes byte-identical', () => runGolden('business-404', '/probe/business-404', 'GET'))

  it('keeps unknown 500 byte-identical without leaking the original message', () => runGolden('unknown-500', '/probe/unknown-500', 'GET'))

  it('keeps business 409 byte-identical', () => runGolden('business-409', '/probe/business-409', 'GET'))

  it('keeps Retry-After on the 429 application error', () => runGolden('rate-limited-429-retry-after', '/probe/rate-limited', 'GET'))

  it('keeps the nested errors lookup byte-identical', () => runGolden('nested-errors-409', '/probe/nested-409', 'GET'))

  it('keeps status-code normalization byte-identical', () => runGolden('declared-status-418', '/probe/declared-418', 'GET'))

  it('keeps storage 415 byte-identical', () => runGolden('storage-415', '/probe/storage-415', 'GET'))

  it('keeps storage 413 byte-identical', () => runGolden('storage-413', '/probe/storage-413', 'GET'))

  it('keeps storage busy 503 with Retry-After byte-identical', () => runGolden('storage-busy-503-retry-after', '/probe/storage-busy', 'GET'))

  it('covers every recorded golden scenario', () => {
    expect(GOLDEN.length).toBe(13)
  })
})
