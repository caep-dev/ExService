import { afterEach, describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { readContract } from '@tests/helpers/contract'
import type {
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from '../../apps/server/node_modules/fastify'
import { createApp, serviceHandlers } from '@workspace/server'
import { AuthError, type AuthErrorCode } from '@server/src/modules/auth/errors'
import { StorageError, type StorageErrorCode } from '@server/src/modules/storage/errors'
import { joinActor, createTestAuth, newJoinApplication, type TestAuth } from '@tests/helpers/auth'
import { joinMultipart, multipartBody, type TestPart } from '@tests/helpers/multipart'
import {
  createAppWithStorage,
  fileStorageFixture,
  type StorageTestFixture,
} from '@tests/helpers/storage'

/**
 * 共用 multipart 上传生命周期的 Contract 层验收。
 *
 * 覆盖三件旧测试没有明确断言的事：
 * 1. 提前终结输出的 envelope 在序列化前后都精确符合 Contract 的 ErrorEnvelope；
 * 2. 共享错误映射只能产出该 operation 在 Contract 已声明的状态码；
 * 3. 两条上传 operation 的 handler 原始返回值（序列化前）符合响应 schema。
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

const fixtures: TestAuth[] = []
const storages: StorageTestFixture[] = []
const apps: Array<ReturnType<typeof createApp>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  for (const storage of storages.splice(0)) storage.cleanup()
})

/**
 * 记录 Glue 交给 Fastify 的 route schema，并保留 route 对象引用。
 *
 * `onRoute` 钩子的执行顺序：本测试的钩子先于各 transport 的钩子，因此 bodyLimit
 * （由 lifecycle controller 赋值）只能在 `app.ready()` 之后从同一对象读取。
 */
function observeRoute(operationId: string) {
  const observed: { statuses: string[]; route?: RouteOptions } = {
    statuses: [],
  }
  return {
    observed,
    hook: (route: RouteOptions) => {
      const schema = route.schema as
        | { operationId?: string; response?: Record<string, unknown> }
        | undefined
      if (schema?.operationId !== operationId) return
      observed.statuses = Object.keys(schema.response ?? {}).sort()
      observed.route = route
    },
  }
}

/** 提前终结适配只能输出数值状态码；Contract 的 `default` 不是可输出状态。 */
const numericStatuses = (statuses: readonly string[]): string[] =>
  statuses.filter((status) => /^[1-9]\d{2}$/.test(status))

const JOIN_UPLOAD_STATUSES = [
  '202',
  '400',
  '401',
  '403',
  '404',
  '408',
  '409',
  '413',
  '415',
  '429',
  '500',
  '503',
]
const STORAGE_UPLOAD_STATUSES = ['200', '400', '401', '408', '409', '413', '415', '500', '503']

/**
 * 提前终结只能输出该 operation 在 Contract 已声明的状态码。
 *
 * 这里逐条钉住「共享映射在本路径上真正会产出的状态」而不是只比对键集合：
 * 命中未声明状态时 `serializeInput` 会抛 `FST_ERR_MISSING_CONTENTTYPE_SERIALIZATION_FN`
 * 而不是回退到默认 serializer，连接会被销毁且没有任何 envelope，排查成本很高。
 */
describe('takeover status guard', () => {
  const declared = (statuses: readonly string[]): number[] => statuses.map(Number)

  it('covers every status the join upload lifecycle can emit', () => {
    const codes: AuthErrorCode[] = [
      'JOIN_UPLOAD_TIMEOUT',
      'JOIN_UPLOAD_TOO_LARGE',
      'JOIN_UPLOAD_BUSY',
      'JOIN_UNSUPPORTED_MEDIA_TYPE',
      'BAD_REQUEST',
    ]
    for (const code of codes) {
      expect(declared(JOIN_UPLOAD_STATUSES), code).toContain(new AuthError(code).statusCode)
    }
  })

  it('covers every status the storage upload lifecycle can emit', () => {
    const codes: StorageErrorCode[] = [
      'STORAGE_TIMEOUT',
      'STORAGE_TOO_LARGE',
      'STORAGE_INVALID_INPUT',
      'STORAGE_UNSUPPORTED_MEDIA_TYPE',
    ]
    for (const code of codes) {
      expect(declared(STORAGE_UPLOAD_STATUSES), code).toContain(new StorageError(code).statusCode)
    }
  })

  it('reports a status the contract never declares for these operations', () => {
    // 负向对照：418 不在两条上传的声明集合里，守卫若失效就会静默丢掉 envelope。
    expect(declared(JOIN_UPLOAD_STATUSES)).not.toContain(418)
    expect(declared(STORAGE_UPLOAD_STATUSES)).not.toContain(418)
  })
})

describe('declared response statuses and body limit', () => {
  it('binds the takeover guard to the join upload statuses declared by the contract', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const { observed, hook } = observeRoute('submitJoinApplication')
    const app = createApp({ ...f, logger: false })
    app.addHook('onRoute', hook)
    apps.push(app)
    await app.ready()
    expect(observed.statuses).toEqual([...JOIN_UPLOAD_STATUSES, 'default'].sort())
    expect(numericStatuses(observed.statuses)).toEqual(JOIN_UPLOAD_STATUSES)
    // bodyLimit 由 controller 独占赋值，数值与 Contract 的 wireBytes 一致。
    expect(observed.route?.bodyLimit).toBe(67108864)
  })

  it('binds the takeover guard to the storage upload statuses declared by the contract', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const storage = fileStorageFixture()
    storages.push(storage)
    const { observed, hook } = observeRoute('uploadStorageContent')
    const app = createAppWithStorage(f, storage.storage)
    app.addHook('onRoute', hook)
    apps.push(app)
    await app.ready()
    expect(observed.statuses).toEqual([...STORAGE_UPLOAD_STATUSES, 'default'].sort())
    expect(numericStatuses(observed.statuses)).toEqual(STORAGE_UPLOAD_STATUSES)
  })
})

describe('early takeover envelope', () => {
  it('keeps admission failures on the normal Fastify error chain with Retry-After', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const app = createApp({ ...f })
    apps.push(app)
    await app.ready()
    // 容量与限流都发生在占位之前：没有 session，不存在提前接管。
    // `trustProxy` 默认为 false，转发头被忽略 —— 这里只是把回环 IP 的预算耗尽。
    const actor = await joinActor(f)
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/communities/rifling-911/applications',
        headers: {
          ...actor.headers,
          'content-type': 'multipart/form-data; boundary=bad',
        },
        payload: 'invalid',
      })
      expect(response.statusCode).toBe(400)
    }
    const multipart = joinMultipart(newJoinApplication())
    const limited = await app.inject({
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...multipart,
      headers: { ...multipart.headers, ...actor.headers },
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('JOIN_RATE_LIMITED')
    expect(limited.headers['cache-control']).toBe('no-store')
    // 限流器按剩余窗口动态计算重试秒数，不能写死；只要求给出可用的整数。
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    validate('ErrorEnvelope', limited.json())
  })

  it('accepts the contract ErrorEnvelope and rejects extra, missing and mistyped fields', () => {
    const envelope = {
      error: { code: 'STORAGE_TIMEOUT', message: 'x', requestId: 'y' },
    }
    expect(validateQuiet('ErrorEnvelope', envelope)).toBe(true)
    expect(
      validateQuiet('ErrorEnvelope', {
        error: {
          code: 'STORAGE_TIMEOUT',
          message: 'x',
          requestId: 'y',
          extra: true,
        },
      }),
    ).toBe(false)
    expect(
      validateQuiet('ErrorEnvelope', {
        error: { code: 'STORAGE_TIMEOUT', message: 'x' },
      }),
    ).toBe(false)
    expect(
      validateQuiet('ErrorEnvelope', {
        error: { code: 'STORAGE_TIMEOUT', message: 'x', requestId: 42 },
      }),
    ).toBe(false)
    expect(
      validateQuiet('ErrorEnvelope', {
        error: { code: 'STORAGE_TIMEOUT', message: 'x', requestId: 'y' },
        extra: 1,
      }),
    ).toBe(false)
  })
})

function validateQuiet(name: string, value: unknown): boolean {
  const check = new Ajv({
    strict: false,
    allErrors: true,
  }).compile({ ...definitions[name], definitions })
  return check(value) === true
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

/**
 * 在测试侧的 onRoute 中包装 Glue 已登记（并被 lifecycle 包装过）的 handler，
 * 捕获序列化之前的原始返回值，避免只断言被 schema 改写过的 HTTP 响应体。
 */
function captureHandlerOutput(operationId: string) {
  const captured: Array<unknown> = []
  let calls = 0
  return {
    captured,
    calls: () => calls,
    hook: (route: RouteOptions) => {
      const schema = route.schema as { operationId?: string } | undefined
      if (schema?.operationId !== operationId) return
      const handler = route.handler as (
        this: unknown,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => unknown
      // 保留 Fastify 传给 handler 的 `this`，不替换成 route 对象。
      route.handler = async function capturedHandler(
        this: unknown,
        request: FastifyRequest,
        reply: FastifyReply,
      ) {
        calls++
        const result = await handler.call(this, request, reply)
        captured.push(result)
        return result
      }
    },
  }
}

describe('raw upload handler output', () => {
  it('returns the contract shape from the real join parser context before serialization', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const capture = captureHandlerOutput('submitJoinApplication')
    const app = createApp({ ...f })
    app.addHook('onRoute', capture.hook)
    apps.push(app)
    await app.ready()

    const actor = await joinActor(f),
      multipart = joinMultipart(newJoinApplication())
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...multipart,
      headers: { ...multipart.headers, ...actor.headers },
    })
    expect(accepted.statusCode, accepted.body).toBe(202)
    expect(capture.calls()).toBe(1)
    const raw = capture.captured[0] as { status: string }
    validate('JoinApplicationReceived', raw)
    expect(Object.keys(raw as object)).toEqual(['status'])
    expect(raw.status).toBe('received')
    // 序列化后的响应与原始返回值一致：这一层断言存在的理由就是发现被 schema 掩盖的漂移。
    expect(accepted.json()).toEqual(raw)
  })

  it('returns the contract shape from the real storage parser context before serialization', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const storage = fileStorageFixture()
    storages.push(storage)
    const capture = captureHandlerOutput('uploadStorageContent')
    const app = createAppWithStorage(f, storage.storage)
    app.addHook('onRoute', capture.hook)
    apps.push(app)
    await app.ready()
    await f.seedUser({
      email: 'raw-storage@example.com',
      nickname: 'Raw',
      password: 'valid password',
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'raw-storage@example.com', password: 'valid password' },
    })
    const token = (login.json() as { token: string }).token

    const { payload, headers } = multipartBody([
      textPart('key', 'raw.bin'),
      dataPart(new Uint8Array([1, 2, 3])),
    ])
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/storage/uploads',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(capture.calls()).toBe(1)
    const raw = capture.captured[0] as { url: string }
    validate('StorageUploadResult', raw)
    expect(Object.keys(raw as object)).toEqual(['url'])
    expect(accepted.json()).toEqual(raw)
    expect(raw.url).toContain('key=raw.bin')
  })

  it('rejects response values that violate the upload result schemas', () => {
    expect(validateQuiet('JoinApplicationReceived', { status: 'received' })).toBe(true)
    expect(validateQuiet('JoinApplicationReceived', {})).toBe(false)
    expect(validateQuiet('JoinApplicationReceived', { status: 'accepted' })).toBe(false)
    expect(
      validateQuiet('JoinApplicationReceived', {
        status: 'received',
        extra: 1,
      }),
    ).toBe(false)
    expect(validateQuiet('StorageUploadResult', { url: 'https://example.test/a' })).toBe(true)
    expect(validateQuiet('StorageUploadResult', {})).toBe(false)
    expect(validateQuiet('StorageUploadResult', { url: 1 })).toBe(false)
  })

  it('rejects a forged storage placeholder through the direct handler without a parser context', async () => {
    const f = await createTestAuth()
    fixtures.push(f)
    const storage = fileStorageFixture()
    storages.push(storage)
    const app = createAppWithStorage(f, storage.storage)
    apps.push(app)
    await app.ready()
    await f.seedUser({
      email: 'forged-storage@example.com',
      nickname: 'Forged',
      password: 'valid password',
    })
    const token = await f.authServices
      .login({
        email: 'forged-storage@example.com',
        password: 'valid password',
      })
      .then((result) => result.token)
    const session = await f.authServices.authenticateToken(token)
    const reply = {
      header: () => reply,
      code: () => reply,
    } as unknown as FastifyReply
    // 直接调用 handler：没有真实解析上下文，伪造的 data 占位标识必须被拒绝。
    // `storage.test.ts` 的 HTTP 用例只断言 >=400，这条把分类钉死为 STORAGE_INVALID_INPUT。
    await expect(
      serviceHandlers.uploadStorageContent(
        {
          server: f,
          authSession: session,
          body: { key: 'a.bin', data: 'storage-content' },
        } as unknown as Parameters<typeof serviceHandlers.uploadStorageContent>[0],
        reply,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_INVALID_INPUT' })
  })
})
