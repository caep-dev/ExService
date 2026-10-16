import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'

/**
 * `apps/server/src/http/shared/query-coercion.ts` 只按**内联** `type` 强制标量查询参数，
 * 遇到 `$ref` 会跳过。这在当前是安全的，前提是 `fastify-openapi-glue` 交给路由的
 * querystring schema 里不存在 `$ref` —— 实测 Glue 解析 Contract 时就把
 * `#/components/schemas/*` 展开了。
 *
 * 这条前提一旦失效（换注册方式、Glue 升级改变行为），`?limit=20` 会重新变成恒 400，
 * 而 `query-coercion.test.ts` 里「`$ref` 属性原样不动」那条**不会**红 —— 它本来就在描述
 * 这个跳过行为。所以这里必须有一条盯住 Glue 实际产出的用例。
 */

const apps: Array<ReturnType<typeof createApp>> = []
const fixtures: TestAuth[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
}, 120_000)

/** 逐个属性断言声明里不含 `$ref`，返回属性表供后续断言。 */
function inlineProperties(querystring: unknown): Record<string, Record<string, unknown>> {
  const properties = (querystring as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties
  expect(properties, 'querystring schema 没有 properties').toBeDefined()
  for (const [name, declared] of Object.entries(properties!)) {
    expect(JSON.stringify(declared), `${name} 的声明里仍含 $ref`).not.toContain('$ref')
  }
  return properties!
}

describe('glue route querystring schema', () => {
  it('hands the route an inlined querystring schema, so $ref scalars are coerced too', async () => {
    const fixture = await createTestAuth()
    fixtures.push(fixture)
    const app = createApp({ ...fixture,
      authServices: fixture.authServices, profileServices: fixture.profileServices,
      storageServices: fixture.storageServices, notifications: fixture.notifications, clickupServices: fixture.clickupServices, supportServices: fixture.supportServices })
    apps.push(app)

    const captured: Array<{ url: string; querystring: unknown }> = []
    app.addHook('preValidation', (request, _reply, done) => {
      captured.push({ url: request.routeOptions.url ?? '', querystring: request.routeOptions.schema?.querystring })
      done()
    })

    await app.ready()
    // 强制逻辑生效的那条路径：带 limit 的历史列表。
    await app.inject({ method: 'GET', url: '/api/notifications?view=history&limit=20' })

    const list = captured.find(entry => entry.url.endsWith('/notifications'))
    expect(list, `captured urls: ${captured.map(entry => entry.url).join(', ')}`).toBeDefined()

    // Contract 里 view / scope / category / cursor 都以 $ref 声明；内联后这五个属性都该在。
    expect(Object.keys(inlineProperties(list!.querystring)).sort())
      .toEqual(['category', 'cursor', 'limit', 'scope', 'view'])
    // 内联必须带上可判定的类型，否则强制无从下手。
    expect(inlineProperties(list!.querystring).limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 })
    expect(inlineProperties(list!.querystring).view).toMatchObject({ type: 'string' })

    // 对照：Glue 不向 Fastify 注册组件 schema，走的确实是内联展开而不是运行时解析。
    expect(Object.keys(app.getSchemas())).toHaveLength(0)
  })
})
