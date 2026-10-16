import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { createApp, serviceHandlers } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import Ajv, { type ValidateFunction } from 'ajv'
import { afterEach, describe, expect, it } from 'vitest'
import { readContract as readDocument, listOperations } from '@tests/helpers/contract'
import { parseCorsAllowedOrigins } from '@server/src/http/cors'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Contract 是 schema 的唯一来源：这里直接读取 `api/generated/openapi.json`，
 * 而不是在测试中手写或复制响应结构。
 */
const contractPath = resolve(projectRoot, 'api/generated/openapi.json')

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

interface ContractDocument {
  paths: Record<string, Record<string, unknown>>
  schemas: Record<string, unknown>
}

/** 解析结果没有类型保证，因此逐步校验结构，让 Contract 结构漂移以明确报错暴露，而不是静默变成 undefined。 */
function readContract(): ContractDocument {
  const parsed: unknown = readDocument(contractPath)

  const paths = (parsed as { paths?: unknown } | null)?.paths
  const components = (parsed as { components?: unknown } | null)?.components
  const schemas = (components as { schemas?: unknown } | null)?.schemas

  if (typeof paths !== 'object' || paths === null) {
    throw new Error(`api/generated/openapi.json 缺少 paths（Contract 结构已变更）: ${contractPath}`)
  }

  if (typeof schemas !== 'object' || schemas === null) {
    throw new Error(`api/generated/openapi.json 缺少 components.schemas（Contract 结构已变更）: ${contractPath}`)
  }

  return {
    paths: paths as Record<string, Record<string, unknown>>,
    schemas: schemas as Record<string, unknown>,
  }
}

const contract = readContract()

/**
 * 列出 Contract 声明的全部 operation。
 *
 * 只有 operationId 才能被 Glue 映射到 handler；漏注册时该路由会在运行时返回 500，
 * 而其他路由与全部断言仍然通过，所以这层漂移必须由测试主动检查。
 */
function listContractOperations(): Array<{ operationId: string; location: string }> {
  return listOperations(readDocument(contractPath))
}

/**
 * 把 Contract 的 `components.schemas` 转成自包含的 Draft-07 definitions，
 * 以便用与 Fastify 默认 Ajv 一致的语义校验响应。
 */
function toDraft07Definitions(schemas: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(schemas).replaceAll('#/components/schemas/', '#/definitions/'),
  ) as Record<string, unknown>
}

const definitions = toDraft07Definitions(contract.schemas)

function compileComponentSchema(name: string): ValidateFunction {
  const schema = definitions[name]

  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`api/generated/openapi.json 缺少 components.schemas.${name}`)
  }

  const ajv = new Ajv({ allErrors: true, strict: false })

  return ajv.compile({ ...(schema as Record<string, unknown>), definitions })
}

const validateHealthResponse = compileComponentSchema('HealthResponse')
const validateErrorEnvelope = compileComponentSchema('ErrorEnvelope')

const runningApps: Array<ReturnType<typeof createApp>> = []
const authFixtures: TestAuth[] = []

async function createTestApp(corsAllowedOrigins?: ReadonlySet<string>, logger: Parameters<typeof createApp>[0]['logger'] = false) {
  const fixture = await createTestAuth()
  authFixtures.push(fixture)
  const app = createApp({ ...fixture, logger, corsAllowedOrigins })
  runningApps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()))
  await Promise.all(authFixtures.splice(0).map((fixture) => fixture.close()))
})

describe('contract coverage', () => {
  it('registers a handler for every operation declared in the contract', () => {
    const operations = listContractOperations()

    expect(operations.length).toBeGreaterThan(0)

    const registered = new Set(Object.keys(serviceHandlers))
    const unregistered = operations
      .filter((operation) => !registered.has(operation.operationId))
      .map((operation) => `${operation.operationId} (${operation.location})`)

    expect(unregistered).toEqual([])
  })

  it('registers no handler that the contract does not declare', () => {
    const declared = new Set(listContractOperations().map((operation) => operation.operationId))
    const undeclared = Object.keys(serviceHandlers).filter((operationId) => !declared.has(operationId))

    expect(undeclared).toEqual([])
  })
})

describe('GET /api/health over HTTP', () => {
  it('returns 200 with a JSON body that satisfies HealthResponse', async () => {
    const app = await createTestApp()

    const response = await app.inject({ method: 'GET', url: '/api/health' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toEqual(expect.any(String))
    expect(response.headers['content-type']).toMatch(/^application\/json/)

    const body: unknown = response.json()
    expect(validateHealthResponse(body)).toBe(true)
    expect(body).toEqual({ status: 'ok' })
  })

  it('returns no fields beyond the ones declared by the contract', async () => {
    const app = await createTestApp()

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>

    expect(Object.keys(body)).toEqual(['status'])
  })

  it('registers the contract path under the explicit /api prefix', async () => {
    const app = await createTestApp()

    // Contract 中路径写作 /health；缺少 prefix 时这里会得到 404。
    const unprefixed = await app.inject({ method: 'GET', url: '/health' })

    expect(unprefixed.statusCode).toBe(404)
  })
})

describe('HTTP infrastructure', () => {
  it('uses a generated request ID and allows only configured CORS preflights', async () => {
    const origin = 'http://127.0.0.1:9999'
    const app = await createTestApp(parseCorsAllowedOrigins(origin))
    const actual = await app.inject({ method: 'GET', url: '/api/health', headers: { origin, 'x-request-id': 'forged' } })
    expect(actual.headers['x-request-id']).not.toBe('forged')
    expect(actual.headers['access-control-allow-origin']).toBe(origin)
    expect(actual.headers['access-control-expose-headers']).toContain('X-Request-Id')
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/health', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'Authorization, Content-Type' } })
    expect(preflight.statusCode).toBe(204)
    expect(preflight.headers['x-request-id']).toEqual(expect.any(String))
    expect(preflight.headers.vary).toContain('Access-Control-Request-Headers')
    const denied = await app.inject({ method: 'OPTIONS', url: '/api/health', headers: { origin, 'access-control-request-method': 'TRACE' } })
    expect(denied.statusCode).toBe(400)
    expect(denied.headers['access-control-allow-methods']).toBeUndefined()
    const outside = await app.inject({ method: 'OPTIONS', url: '/api-other', headers: { origin, 'access-control-request-method': 'GET' } })
    expect(outside.statusCode).toBe(404)
    expect(outside.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects wildcard and origins with a path', () => {
    expect(() => parseCorsAllowedOrigins('*')).toThrow()
    expect(() => parseCorsAllowedOrigins('https://example.test/admin')).toThrow()
  })
})

/**
 * 这一组是必需的，不能只靠上面的 HTTP 断言。
 *
 * Fastify 会用 Contract 的 response schema 序列化响应：未声明的字段被静默丢弃，
 * `const` 声明被强制写入。实测 handler 返回 `{status:'ok',secret:'x'}`、`{status:'down'}`
 * 或 `{status:42}` 时，线上响应都仍然是 `{"status":"ok"}`。
 * 因此 handler 的回归只能通过直接校验它注册在 `serviceHandlers` 中的原始返回值来发现。
 */
describe('registered handler output', () => {
  it('satisfies HealthResponse before serialization', async () => {
    const result = await serviceHandlers.getHealth()

    expect(validateHealthResponse(result)).toBe(true)
    expect(result).toEqual({ status: 'ok' })
  })

  it('exposes only the fields declared by the contract', async () => {
    const result = await serviceHandlers.getHealth()

    expect(Object.keys(result)).toEqual(['status'])
  })
})

describe('contract schema enforcement', () => {
  it('rejects a response body that carries an undeclared field', () => {
    expect(validateHealthResponse({ status: 'ok', uptime: 1 })).toBe(false)
  })

  it('rejects a response body that is missing a required field', () => {
    expect(validateHealthResponse({})).toBe(false)
  })

  it('rejects a response body whose value violates the contract constant', () => {
    expect(validateHealthResponse({ status: 'down' })).toBe(false)
  })

  it('rejects a response body whose value has the wrong type', () => {
    expect(validateHealthResponse({ status: 42 })).toBe(false)
  })
})

describe('undeclared routes', () => {
  it('returns the contract ErrorEnvelope', async () => {
    const app = await createTestApp()

    const response = await app.inject({ method: 'GET', url: '/api/not-in-contract' })
    expect(response.headers['x-request-id']).toEqual(expect.any(String))
    expect(response.headers['x-request-id']).toBe(response.json().error.requestId)

    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    expect(validateErrorEnvelope(response.json())).toBe(true)
  })

  it('uses the same generated ID in error headers, bodies, and request logs', async () => {
    const lines: string[] = []
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
    const app = await createTestApp(undefined, { stream })
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {}, headers: { 'x-request-id': 'forged-id' } })
    const id = response.headers['x-request-id']
    expect(response.statusCode).toBe(400)
    expect(id).toEqual(expect.any(String))
    expect(id).not.toBe('forged-id')
    expect(response.json().error.requestId).toBe(id)
    expect(lines.map(line => JSON.parse(line) as { reqId?: string }).some(entry => entry.reqId === id)).toBe(true)
  })

  it('does not leak internal details', async () => {
    const app = await createTestApp()

    const body = (await app.inject({ method: 'GET', url: '/api/not-in-contract' })).json() as {
      error: { message: string; requestId: string }
    }

    expect(body.error.requestId).toBeTruthy()
    expect(body.error.message).not.toContain(projectRoot)
    expect(body.error.message).not.toMatch(/postgres(?:ql)?:\/\/|DATABASE_URL|node_modules|\bat\s+\S+\s+\(/i)
  })
})
