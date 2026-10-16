import { request as httpRequest, type ClientRequest } from 'node:http'
import { Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from '../../apps/server/node_modules/fastify'
import { readContract } from '@tests/helpers/contract'
import { createApp } from '@workspace/server'
import { joinActor, createTestAuth, newJoinApplication, type TestAuth } from '@tests/helpers/auth'
import { joinMultipart, multipartBody, type TestPart } from '@tests/helpers/multipart'
import {
  createAppWithStorage,
  fileStorageFixture,
  type StorageTestFixture,
} from '@tests/helpers/storage'
import type { StorageServices } from '@server/src/modules/storage/factory'

/**
 * 共用 multipart 上传生命周期的真实连接验收。
 *
 * 这些用例只在真实 socket 上成立：`app.inject()` 会一次性交出完整请求体，
 * 无法构造 stalled part、只发 headers、deadline 竞争或响应头已发出的状态。
 * 资源释放一律用可观察结果（后续成功上传、容量拒绝、handler 未被调用）证明，
 * 不靠内存数字或 GC 时间判定。
 */

const contract = readContract(new URL('../../api/generated/openapi.json', import.meta.url))
const definitions = JSON.parse(
  JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'),
)
function validate(name: string, value: unknown) {
  const check = new Ajv({
    strict: false,
    allErrors: true,
  }).compile({ ...definitions[name], definitions })
  expect(check(value), JSON.stringify(check.errors)).toBe(true)
}

const joinContexts = new Map<
  number,
  { f: TestAuth; actor: Awaited<ReturnType<typeof joinActor>> }
>()
let joinUserCounter = 0
const fixtures: TestAuth[] = []
const apps: FastifyInstance[] = []
const storages: StorageTestFixture[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  for (const storage of storages.splice(0)) storage.cleanup()
})

interface Connection {
  req: ClientRequest
  result: Promise<{
    status: number
    headers: Record<string, string | string[] | undefined>
    body: string
  }>
  /** 连接被中断前收到的原始字节；用于断言没有把 JSON 追加到半截字节后面。 */
  partial: () => Buffer
}

function client(
  port: number,
  path: string,
  method = 'POST',
  headers: Record<string, string> = {},
): Connection {
  const chunks: Buffer[] = []
  let req!: ClientRequest
  const result = new Promise<{
    status: number
    headers: Record<string, string | string[] | undefined>
    body: string
  }>((resolve, reject) => {
    req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(path.includes('/communities/') ? joinContexts.get(port)?.actor.headers : {}),
          ...headers,
        },
        agent: false,
      },
      (res) => {
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
  })
  // Deliberate disconnect tests must not create an unhandled rejected Promise.
  void result.catch(() => {})
  return { req, result, partial: () => Buffer.concat(chunks) }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300))

/** 覆盖某 operation 的 route config 限额，并暴露该活动对象与恢复 deadline 的入口。 */
function overrideConfig(
  app: FastifyInstance,
  key: 'joinUpload' | 'storageUpload',
  overrides: Record<string, number>,
) {
  let limits: Record<string, number> | undefined
  let originalDeadline: number | undefined
  app.addHook('onRoute', (route) => {
    const config = (route.config ?? {}) as Record<string, Record<string, number> | undefined>
    const found = config[key]
    if (found === undefined) return
    limits = found
    originalDeadline = found.deadlineMs
    Object.assign(found, overrides)
  })
  return {
    /** 限额对象保持活动：测试可在请求之间继续调整它。 */
    limits: () => {
      if (limits === undefined) throw new Error(`${key} route was not registered`)
      return limits
    },
    restoreDeadline: () => {
      if (limits === undefined || originalDeadline === undefined)
        throw new Error(`${key} route was not registered`)
      limits.deadlineMs = originalDeadline
    },
  }
}

async function joinPath(port: number, email: string) {
  const body = joinMultipart(newJoinApplication(email))
  const actor = await joinActor(joinContexts.get(port)!.f, `submit-${++joinUserCounter}-${email}`)
  Object.assign(body.headers, actor.headers)
  const connection = client(port, '/api/communities/rifling-911/applications', 'POST', body.headers)
  connection.req.end(body.payload)
  return connection.result
}

function textPart(name: string, value: string): TestPart {
  return { name, contentType: 'text/plain', bytes: Buffer.from(value, 'utf8') }
}
function dataPart(bytes: Uint8Array): TestPart {
  return {
    name: 'data',
    filename: 'upload.bin',
    contentType: 'application/octet-stream',
    bytes: Buffer.from(bytes),
  }
}

async function joinSetup(
  overrides: Record<string, number> = {},
  configure?: (app: FastifyInstance) => void,
) {
  const f = await createTestAuth()
  fixtures.push(f)
  const app = createApp({ ...f })
  apps.push(app)
  const { restoreDeadline } = overrideConfig(app, 'joinUpload', overrides)
  const events: string[] = []
  // 记录已进入解析阶段的请求数，作为「槽位确实被占住」的可观察屏障。
  let observed = 0
  const waiters: Array<{ count: number; resolve: () => void }> = []
  app.addHook('preValidation', async (request) => {
    if (request.url !== '/api/communities/rifling-911/applications') return
    observed++
    for (const waiter of waiters.filter((waiter) => waiter.count <= observed)) waiter.resolve()
  })
  app.addHook('preHandler', async (request) => {
    if (request.url === '/api/communities/rifling-911/applications') events.push('preHandler')
  })
  configure?.(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('No socket address')
  joinContexts.set(address.port, {
    f,
    actor: await joinActor(f, `socket-${++joinUserCounter}@example.com`),
  })
  return {
    f,
    app,
    port: address.port,
    events,
    restoreDeadline,
    entered: (count: number) =>
      observed >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
  }
}

async function storageSetup(
  options: {
    overrides?: Record<string, number>
    maxBytes?: string
    origins?: ReadonlySet<string>
    logger?: { stream: Writable; level: string }
  } = {},
) {
  const f = await createTestAuth()
  fixtures.push(f)
  const storage = fileStorageFixture(
    options.maxBytes === undefined ? undefined : { STORAGE_MAX_BYTES: options.maxBytes },
  )
  storages.push(storage)
  const app =
    options.origins === undefined && options.logger === undefined
      ? createAppWithStorage(f, storage.storage)
      : createApp({
          ...f,
          storageServices: storage.storage,
          corsAllowedOrigins: options.origins,
          logger: options.logger,
        })
  apps.push(app)
  const config =
    options.overrides === undefined
      ? {
          limits: () => {
            throw new Error('storageUpload overrides were not requested')
          },
          restoreDeadline: () => undefined,
        }
      : overrideConfig(app, 'storageUpload', options.overrides)
  // 与 join 同款屏障：存储槽位被占住时才能证明两条路径容量互相独立。
  let observed = 0
  const waiters: Array<{ count: number; resolve: () => void }> = []
  app.addHook('preValidation', async (request) => {
    if (request.url !== '/api/storage/uploads') return
    observed++
    for (const waiter of waiters.filter((waiter) => waiter.count <= observed)) waiter.resolve()
  })
  await f.seedUser({
    email: 'lifecycle@example.com',
    nickname: 'Lifecycle',
    password: 'valid password',
  })
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'lifecycle@example.com', password: 'valid password' },
  })
  expect(login.statusCode).toBe(200)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('No socket address')
  joinContexts.set(address.port, {
    f,
    actor: await joinActor(f, `storage-join-${++joinUserCounter}@example.com`),
  })
  return {
    f,
    app,
    port: address.port,
    services: storage.storage,
    limits: config.limits,
    restoreDeadline: config.restoreDeadline,
    token: (login.json() as { token: string }).token,
    entered: (count: number) =>
      observed >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
  }
}

/** 只写第一个 part 的头部与半个字段值并挂住：解析停在字段内，请求一直占着槽位。 */
function holdStorage(port: number, token: string, boundary = 'lifecycle-boundary') {
  const connection = client(port, '/api/storage/uploads', 'POST', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    authorization: `Bearer ${token}`,
  })
  connection.req.write(`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\nstall`)
  return connection
}

it('takeover keeps the exact contract envelope, content type and safe headers on a real socket', async () => {
  const { port, token } = await storageSetup({
    overrides: { deadlineMs: 150 },
  })
  const connection = holdStorage(port, token)
  const response = await connection.result
  expect(response.status).toBe(408)
  const body = JSON.parse(response.body) as {
    error: { code: string; message: string; requestId: string }
  }
  expect(body.error.code).toBe('STORAGE_TIMEOUT')
  // 序列化前的 envelope 与序列化后的真实响应都精确符合 Contract。
  expect(Object.keys(body)).toEqual(['error'])
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId'])
  validate('ErrorEnvelope', body)
  // content-type 是「显式状态码 + application/json 选中正确 serializer」唯一的线上可观测证据。
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['connection']).toBe('close')
  expect(response.headers['x-request-id']).toEqual(expect.any(String))
  expect(body.error.requestId).toBe(response.headers['x-request-id'])
  expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)))
}, 60000)

it('keeps CORS and Vary headers through the takeover response', async () => {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk))
      done()
    },
  })
  const origin = 'http://127.0.0.1:9999'
  const { port, token } = await storageSetup({
    overrides: { deadlineMs: 150 },
    origins: new Set([origin]),
    logger: { stream, level: 'warn' },
  })
  const connection = client(port, '/api/storage/uploads', 'POST', {
    'content-type': 'multipart/form-data; boundary=lifecycle-boundary',
    authorization: `Bearer ${token}`,
    origin,
  })
  connection.req.write(
    '--lifecycle-boundary\r\nContent-Disposition: form-data; name="key"\r\n\r\nstall',
  )
  const response = await connection.result
  expect(response.status).toBe(408)
  // 接管不走 onSend，因此 foundation 在 onRequest 设置的 CORS 头必须靠 getHeaders() 透传。
  expect(response.headers['access-control-allow-origin']).toBe(origin)
  expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id')
  expect(String(response.headers['vary'])).toContain('Origin')
  expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
  // 迟到 rejection 已被消费：日志里只有安全分类，没有原始异常文本。
  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(
    entries.some((entry) => entry.code === 'STORAGE_TIMEOUT' && entry.statusCode === 408),
  ).toBe(true)
  const text = lines.join('\n')
  for (const leak of [
    'premature close',
    'PrematureClose',
    'Stream destroyed',
    'unexpected end of form',
    'ERR_STREAM_PREMATURE_CLOSE',
    ' at ',
  ]) {
    expect(text, leak).not.toContain(leak)
  }
  lines.length = 0
}, 60000)

it('counts chunked wire bytes without Content-Length, takes over with 413 and permits a real retry', async () => {
  const { port, restoreDeadline } = await joinSetup({
    wireBytes: 65536,
    deadlineMs: 150,
  })
  const overflow = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=lifecycle-boundary',
  })
  // 无 Content-Length：只有 counter 能拦住超限的 wire。
  overflow.req.write(Buffer.alloc(65537, 65))
  overflow.req.end()
  const rejected = await overflow.result
  expect(rejected.status, rejected.body).toBe(413)
  const body = JSON.parse(rejected.body) as { error: { code: string } }
  expect(body.error.code).toBe('JOIN_UPLOAD_TOO_LARGE')
  validate('ErrorEnvelope', body)
  expect(rejected.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(rejected.headers['cache-control']).toBe('no-store')

  restoreDeadline()
  const accepted = await joinPath(port, 'wire-takeover-retry@example.com')
  expect(accepted.status, accepted.body).toBe(202)
}, 60000)

it('cancels a join upload that stalls after a completed proof and still accepts a real retry', async () => {
  const { port, f, events, restoreDeadline } = await joinSetup({
    deadlineMs: 200,
  })
  const submit = vi.spyOn(f.joinServices, 'submit')
  const boundary = 'partial-boundary'
  const application = JSON.stringify(newJoinApplication('partial@example.com'))
  const connection = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  })
  connection.req.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="application"; filename="application.json"\r\nContent-Type: application/json\r\n\r\n${application}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="proofs"; filename="first.txt"\r\nContent-Type: application/octet-stream\r\n\r\nevidence\r\n` +
      // 第二个附件只写头部：解析停在这一 part 内，deadline 到期后接管。
      `--${boundary}\r\nContent-Disposition: form-data; name="proofs"; filename="second.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const response = await connection.result
  expect(response.status).toBe(408)
  expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
    'JOIN_UPLOAD_TIMEOUT',
  )
  // 部分 proof 已 staging 也不发布：业务 submit 一次都没有被调用。
  expect(submit).toHaveBeenCalledTimes(0)
  expect(events).toEqual([])
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 0 })

  restoreDeadline()
  const retried = await joinPath(port, 'partial-retry@example.com')
  expect(retried.status, retried.body).toBe(202)
  expect(submit).toHaveBeenCalledTimes(1)
}, 60000)

it('destroys the connection without appending JSON when the join response headers were already sent', async () => {
  const f = await createTestAuth()
  fixtures.push(f)
  const app = createApp({ ...f })
  apps.push(app)
  let release!: () => void
  const hanging = new Promise<void>((resolve) => {
    release = resolve
  })
  // 业务 handler 先自己写出响应头与半截字节，然后挂住：ownership 尚未确定时 deadline 到期。
  app.addHook('onRoute', (route: RouteOptions) => {
    const schema = route.schema as { operationId?: string } | undefined
    if (schema?.operationId !== 'submitJoinApplication') return
    const handler = route.handler as (request: FastifyRequest, reply: FastifyReply) => unknown
    route.handler = async (request, reply) => {
      reply.raw.writeHead(202, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      })
      reply.raw.write('partial-bytes')
      await hanging
      return handler.call(route, request, reply)
    }
  })
  overrideConfig(app, 'joinUpload', { deadlineMs: 200 })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('No socket address')

  try {
    const body = joinMultipart(newJoinApplication('headers-sent@example.com'))
    joinContexts.set(address.port, {
      f,
      actor: await joinActor(f, `manual-${++joinUserCounter}@example.com`),
    })
    const connection = client(
      address.port,
      '/api/communities/rifling-911/applications',
      'POST',
      body.headers,
    )
    connection.req.end(body.payload)
    const failure = await connection.result.then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    // 头已发出后只能终止连接：不能把 JSON 追加到半截字节后面。
    expect(failure?.code).toBe('ECONNRESET')
    expect(connection.partial().toString()).toBe('partial-bytes')
    expect(connection.partial().toString()).not.toContain('"error"')
  } finally {
    release()
  }
  await nextTurn()
}, 60000)

it('accepts a real chunked storage upload of exactly the wire budget and stores its bytes', async () => {
  const maxBytes = 1024
  const body = multipartBody([textPart('key', 'exact.bin'), dataPart(new Uint8Array(maxBytes))])
  // 让 wire 预算恰好等于这份真实 multipart 的长度；+1 变体只把开销减一。
  const overhead = body.payload.length - maxBytes
  expect(overhead).toBeGreaterThan(1)
  const { port, app, token, limits } = await storageSetup({
    overrides: { wireOverheadBytes: overhead, deadlineMs: 400 },
    maxBytes: String(maxBytes),
  })

  // chunked（不设 Content-Length）：wire 恰好等于预算时 counter 放行。
  const exact = client(port, '/api/storage/uploads', 'POST', {
    ...body.headers,
    authorization: `Bearer ${token}`,
  })
  exact.req.write(body.payload)
  exact.req.end()
  const accepted = await exact.result
  expect(accepted.status, accepted.body).toBe(200)
  // 字节确实落盘：走公开下载路由取回，而不是只信 200。
  const stored = await app.inject({
    method: 'GET',
    url: '/api/storage/files?key=exact.bin',
  })
  expect(stored.statusCode).toBe(200)
  expect(stored.rawPayload.byteLength).toBe(maxBytes)

  // 同一份真实 multipart，预算少一个字节：这次由 counter 拦下。
  limits().wireOverheadBytes = overhead - 1
  const over = client(port, '/api/storage/uploads', 'POST', {
    ...body.headers,
    authorization: `Bearer ${token}`,
  })
  over.req.write(body.payload)
  over.req.end()
  const rejected = await over.result
  expect(rejected.status, rejected.body).toBe(413)
  expect((JSON.parse(rejected.body) as { error: { code: string } }).error.code).toBe(
    'STORAGE_TOO_LARGE',
  )
  expect(rejected.headers['content-type']).toBe('application/json; charset=utf-8')
}, 60000)

it('runs admission before any body byte and still serves a legal request afterwards', async () => {
  const { port, app, f, token, services } = await storageSetup()
  const upload = vi.spyOn(services.service, 'upload')
  const submit = vi.spyOn(f.joinServices, 'submit')

  // 只发 headers 不送 body：未认证请求必须在消费请求体之前就被拒绝。
  const anonymous = client(port, '/api/storage/uploads', 'POST', {
    'content-type': 'multipart/form-data; boundary=admission-boundary',
  })
  anonymous.req.flushHeaders()
  const rejected = await anonymous.result
  expect(rejected.status).toBe(401)
  expect((JSON.parse(rejected.body) as { error: { code: string } }).error.code).toBe(
    'SESSION_INVALID',
  )
  expect(upload).toHaveBeenCalledTimes(0)

  // 加入申请：限流同样先于读体。`trustProxy` 默认为 false，转发头被忽略，
  // 这些请求一律按回环 IP 计数 —— 这里只是把该 IP 的预算耗尽。
  for (let i = 0; i < 60; i++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      headers: {
        ...joinContexts.get(port)!.actor.headers,
        'content-type': 'multipart/form-data; boundary=bad',
      },
      payload: 'invalid',
    })
    expect(response.statusCode).toBe(400)
  }
  const limited = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=admission-boundary',
  })
  limited.req.flushHeaders()
  const throttled = await limited.result
  expect(throttled.status).toBe(429)
  expect((JSON.parse(throttled.body) as { error: { code: string } }).error.code).toBe(
    'JOIN_RATE_LIMITED',
  )
  // 限流器按剩余窗口动态计算，不能写死；只要求给出可用的重试秒数。
  expect(Number(throttled.headers['retry-after'])).toBeGreaterThanOrEqual(1)
  expect(submit).toHaveBeenCalledTimes(0)

  // 认证与限流之外没有别的永久拒绝：合法请求仍然成功。
  const { payload, headers } = multipartBody([
    textPart('key', 'admission.bin'),
    dataPart(new Uint8Array([1, 2])),
  ])
  const accepted = client(port, '/api/storage/uploads', 'POST', {
    ...headers,
    authorization: `Bearer ${token}`,
  })
  accepted.req.end(payload)
  expect((await accepted.result).status).toBe(200)
  expect(upload).toHaveBeenCalledTimes(1)
}, 60000)

it('restores the same original raw on success, parser failure, takeover and abort', async () => {
  const originals = new WeakMap<FastifyRequest, unknown>()
  const atPreHandler: boolean[] = []
  const atResponse: Array<{ restored: boolean; status: number }> = []
  const atClose: boolean[] = []
  const { port, entered } = await joinSetup({ deadlineMs: 150 }, (app) => {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url !== '/api/communities/rifling-911/applications') return
      const original = request.raw
      originals.set(request, original)
      // 同步注册以免错过同一轮循环里就关闭的连接；比较推迟一拍，
      // 这样无论本监听与 lifecycle 自己的连接监听谁先触发，看到的都是还原之后的 raw。
      // 响应侧与请求侧都观察（客户端主动断开时响应对象不会 close），每个请求只记一次。
      let seen = false
      const observe = () => {
        if (seen) return
        seen = true
        setImmediate(() => {
          atClose.push(request.raw === original)
        })
      }
      reply.raw.once('close', observe)
      original.once('close', observe)
    })
    app.addHook('preHandler', async (request) => {
      if (request.url === '/api/communities/rifling-911/applications')
        atPreHandler.push(originals.get(request) === request.raw)
    })
    // onResponse 晚于 transport 的钩子；提前终结是否走这条链由断言中的状态一并记录。
    app.addHook('onResponse', async (request, reply) => {
      if (request.url === '/api/communities/rifling-911/applications') {
        atResponse.push({
          restored: originals.get(request) === request.raw,
          status: reply.statusCode,
        })
      }
    })
  })

  // 1. 成功路径：preValidation 的 finally 还原 raw，preHandler 与 onResponse 都看到原始对象。
  expect((await joinPath(port, 'raw-restore@example.com')).status).toBe(202)
  expect(atPreHandler).toEqual([true])
  await settle()
  expect(atResponse).toEqual([{ restored: true, status: 202 }])
  expect(atClose).toEqual([true])

  // 2. 解析失败（普通错误链）：onError/onResponse 之后 raw 仍是同一个对象。
  // 显式要求关闭连接，让 `reply.raw` 的 close 观察点确定发生。
  const invalid = joinMultipart(newJoinApplication('bad@example.com'), [
    { bytes: Buffer.from('x') },
  ])
  const rejected = client(port, '/api/communities/rifling-911/applications', 'POST', {
    ...invalid.headers,
    connection: 'close',
  })
  rejected.req.end(invalid.payload)
  expect((await rejected.result).status).toBe(400)
  await settle()
  expect(atResponse).toEqual([
    { restored: true, status: 202 },
    { restored: true, status: 400 },
  ])
  expect(atClose).toEqual([true, true])

  // 3. deadline 提前接管：不走 Fastify 发送链，仍须在连接关闭前还原 raw。
  const timedOut = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=stop-boundary',
  })
  timedOut.req.write(
    '--stop-boundary\r\nContent-Disposition: form-data; name="application"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"email":',
  )
  expect((await timedOut.result).status).toBe(408)
  await settle()
  // 接管路径没有 onResponse，只有 close 观察点。
  // 接管也会走完 onResponse（reply.code(408) 后由 raw 输出），因此这里同样核对身份。
  expect(atResponse).toEqual([
    { restored: true, status: 202 },
    { restored: true, status: 400 },
    { restored: true, status: 408 },
  ])
  expect(atClose).toEqual([true, true, true])

  // 4. 客户端主动断开：onRequestAbort 路径同样还原。
  const aborted = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=stop-boundary',
  })
  aborted.req.write(
    '--stop-boundary\r\nContent-Disposition: form-data; name="application"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"email":',
  )
  // 等请求真正进入解析阶段再断开：否则可能连请求头都没发出去，服务端根本没建会话。
  await entered(4)
  aborted.req.destroy()
  await expect(aborted.result).rejects.toThrow()
  // 主动断开的连接关闭时机由对端决定，用轮询等它真正发生，再核对身份。
  await expect.poll(() => atClose.length, { timeout: 5000 }).toBe(4)
  expect(atClose).toEqual([true, true, true, true])
}, 60000)

it('stops the Fastify chain before the business handler when the deadline wins', async () => {
  const { port, f, events } = await joinSetup({ deadlineMs: 150 })
  const submit = vi.spyOn(f.joinServices, 'submit')
  const connection = client(port, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=stop-boundary',
  })
  connection.req.write(
    '--stop-boundary\r\nContent-Disposition: form-data; name="application"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"email":',
  )
  const response = await connection.result
  expect(response.status).toBe(408)
  // 接管之后尚未开始的 preHandler 与业务 handler 都不执行。
  expect(events).toEqual([])
  expect(submit).toHaveBeenCalledTimes(0)
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 0 })
}, 60000)

it('releases each slot exactly once across repeated cancellations', async () => {
  // 占用窗口按秒计：被占用的请求若先超时，'占用期间第三个被拒' 会静默退化成空跑并通过。
  const { port, f, restoreDeadline, entered } = await joinSetup({
    deadlineMs: 3000,
  })
  const submit = vi.spyOn(f.joinServices, 'submit')
  let settled = 0
  const hold = () => {
    const connection = client(port, '/api/communities/rifling-911/applications', 'POST', {
      'content-type': 'multipart/form-data; boundary=hold-boundary',
    })
    connection.req.write(
      '--hold-boundary\r\nContent-Disposition: form-data; name="application"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{',
    )
    // 记录被占用的请求何时结束，用于证明下面的探测确实发生在占用期间。
    void connection.result.then(
      () => {
        settled++
      },
      () => {
        settled++
      },
    )
    return connection
  }
  /** 第三个请求只发 headers：槽位满时在占位之前就被拒。 */
  const probe = async () => {
    const connection = client(port, '/api/communities/rifling-911/applications', 'POST', {
      'content-type': 'multipart/form-data; boundary=hold-boundary',
    })
    connection.req.flushHeaders()
    return connection.result
  }
  // 取消方式交替：deadline 接管、客户端主动断开、deadline 接管。
  // 每轮都先证明「占用期间第三个被拒」，再证明「取消后两个槽位都真的回收」。
  for (const round of [0, 1, 2]) {
    settled = 0
    const first = hold(),
      second = hold()
    await entered(round * 4 + 2)
    const busy = await probe()
    // 若两个被占用的请求已经结束，这条 503 就可能是空跑 —— 直接把它变成失败。
    expect(settled, `round ${round} overlap`).toBe(0)
    expect(busy.status, `round ${round}`).toBe(503)
    expect((JSON.parse(busy.body) as { error: { code: string } }).error.code).toBe(
      'JOIN_UPLOAD_BUSY',
    )
    // 容量耗尽的 503 由 Fastify 正常错误链输出，Retry-After 是构造死值 5。
    expect(busy.headers['retry-after']).toBe('5')

    if (round === 1) {
      first.req.destroy()
      second.req.destroy()
      await expect(first.result).rejects.toThrow()
      await expect(second.result).rejects.toThrow()
    } else {
      expect((await first.result).status).toBe(408)
      expect((await second.result).status).toBe(408)
    }
    // 清理是异步收束 parse 之后才释放槽位；等它真正结束再验回收。
    await settle()
    // 两个槽位都已回收且没有漏释放：两次真实上传都成功。
    expect((await joinPath(port, `released-${round}-a@example.com`)).status).toBe(202)
    expect((await joinPath(port, `released-${round}-b@example.com`)).status).toBe(202)
    await entered(round * 4 + 4)
  }
  // 最后一轮再钉一次「占用期间第三个被拒」：容量始终恰好是 2，没有因重复释放而扩大。
  const lastA = hold(),
    lastB = hold()
  await entered(14)
  const busy = await probe()
  expect(busy.status).toBe(503)
  expect((JSON.parse(busy.body) as { error: { code: string } }).error.code).toBe('JOIN_UPLOAD_BUSY')

  restoreDeadline()
  lastA.req.destroy()
  lastB.req.destroy()
  await Promise.all([lastA.result.catch(() => undefined), lastB.result.catch(() => undefined)])
  const accepted = await joinPath(port, 'slot-recycle@example.com')
  expect(accepted.status, accepted.body).toBe(202)
  expect(submit).toHaveBeenCalledTimes(7)
}, 60000)

it('keeps the two operations on independent capacities while both are occupied', async () => {
  // 同上：存储槽位的占用窗口按秒计，保证 join 上传与存储占用真实重叠。
  const { port, f, token, services, entered } = await storageSetup({
    overrides: { deadlineMs: 3000 },
  })
  const upload = vi.spyOn(services.service, 'upload')
  // 占满存储上传的两个槽位，并等到两者都真正进入解析阶段。
  let settled = 0
  const held = [
    holdStorage(port, token, 'independence-a-boundary'),
    holdStorage(port, token, 'independence-b-boundary'),
  ]
  for (const connection of held)
    void connection.result.then(
      () => {
        settled++
      },
      () => {
        settled++
      },
    )
  await entered(2)

  // 占用期间：带有效 Bearer 的第三个存储请求在占位前被拒。
  const third = client(port, '/api/storage/uploads', 'POST', {
    'content-type': 'multipart/form-data; boundary=independence-c-boundary',
    authorization: `Bearer ${token}`,
  })
  third.req.flushHeaders()
  const busy = await third.result
  expect(busy.status).toBe(503)
  expect((JSON.parse(busy.body) as { error: { code: string } }).error.code).toBe('STORAGE_BUSY')
  expect(busy.headers['retry-after']).toBe('5')

  // 同一时刻加入申请仍需被接受：它有自己的 slots，不与存储共享总池。
  const accepted = await joinPath(port, 'independent-capacity@example.com')
  expect(accepted.status, accepted.body).toBe(202)
  expect(upload).toHaveBeenCalledTimes(0)
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 1 })
  // 两条断言都必须发生在存储槽位仍被占用期间；否则「独立」就是空跑。
  expect(settled, 'storage slots still occupied').toBe(0)

  for (const connection of held) expect((await connection.result).status).toBe(408)
}, 60000)

it('keeps upload capacities per Fastify instance rather than per process', async () => {
  const f = await createTestAuth()
  fixtures.push(f)
  const first = createApp({ ...f })
  const second = createApp({ ...f })
  apps.push(first, second)
  for (const app of [first, second]) {
    // 占用窗口按秒计：两个实例的探测都必须发生在 A 仍占满两槽的期间。
    overrideConfig(app, 'joinUpload', { deadlineMs: 3000 })
    await app.listen({ host: '127.0.0.1', port: 0 })
  }
  const portOf = (app: FastifyInstance): number => {
    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('No socket address')
    return address.port
  }
  const portA = portOf(first),
    portB = portOf(second)
  const actor = await joinActor(f, `instance-${++joinUserCounter}@example.com`)
  joinContexts.set(portA, { f, actor })
  joinContexts.set(portB, { f, actor })

  // 把实例 A 的两个槽位占满。
  let settled = 0
  const held = [0, 1].map(() => {
    const connection = client(portA, '/api/communities/rifling-911/applications', 'POST', {
      'content-type': 'multipart/form-data; boundary=instance-boundary',
    })
    connection.req.write(
      '--instance-boundary\r\nContent-Disposition: form-data; name="application"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{',
    )
    void connection.result.then(
      () => {
        settled++
      },
      () => {
        settled++
      },
    )
    return connection
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const busy = client(portA, '/api/communities/rifling-911/applications', 'POST', {
    'content-type': 'multipart/form-data; boundary=instance-boundary',
  })
  busy.req.flushHeaders()
  expect((await busy.result).status).toBe(503)

  // 同一进程内的另一个 Fastify 实例不受影响：容量不是进程级共享的。
  const accepted = await joinPath(portB, 'second-instance@example.com')
  expect(accepted.status, accepted.body).toBe(202)
  // 上面两条断言必须发生在 A 仍占满两槽的期间，否则「B 不受影响」证明不了任何事。
  expect(settled, 'instance A slots still occupied').toBe(0)

  for (const connection of held) expect((await connection.result).status).toBe(408)
}, 60000)
