import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, serviceHandlers } from '@workspace/server'
import type { AppDatabase } from '@server/src/db/client'
import { createAuthServices, createRegistrationServices } from '@server/src/create-services'
import {createCfxServices} from '@server/src/modules/cfx/service'
import { ProfileService } from '@server/src/modules/profile/service'
import { createStorageModule } from '@server/src/modules/storage/factory'
import { parseStorageConfig } from '@server/src/modules/storage/config'
import { createNotificationModule } from '@server/src/modules/notifications/factory'
import authPlugin from '@server/src/modules/auth/plugin'
import profilePlugin from '@server/src/modules/profile/plugin'
import identityPlugin from '@server/src/modules/identity/plugin'
import authApi from '@server/src/modules/auth/api/plugin'
import profileApi from '@server/src/modules/profile/api/plugin'
import { mergeOperations } from '@server/src/http/service-handlers'
import { readContract, listOperations, assertOperationCoverage } from '@server/src/contract/document'
import { formatBusinessPluginError, BusinessPluginLoadError } from '@server/src/business-plugin-errors'
import { unavailableSupport } from '@tests/helpers/support'

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const Fastify: () => ReturnType<typeof createApp> = require('fastify')
const fp = require('fastify-plugin')
const apps: ReturnType<typeof createApp>[] = []
const directories: string[] = []
const database: AppDatabase = {
  async query(sql) { if(sql.startsWith('UPDATE auth_registration_deliveries SET status='))return {rows:[],rowCount:0};throw new Error('boot tests must not query business data') },
  async transaction(run) { return run(database) },
  async close() { throw new Error('plugins must not close injected resources') },
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'exwebsite-plugin-'))
  directories.push(directory)
  const auth=createAuthServices({db:database,codeHmacKey:Buffer.alloc(32,7)}),cfxServices=createCfxServices({config:{enabled:false}});
  const notifications=createNotificationModule({db:database,tokenKey:Buffer.alloc(32,3)});
  const profileServices = new ProfileService(database, directory, 'http://localhost:8080/api/avatars')
  return {
    ...auth,cfxServices,...createRegistrationServices({db:database,...auth,codeHmacKey:Buffer.alloc(32,7),cfxServices,notifications}),
    profileServices,
    storageServices: createStorageModule({ config: parseStorageConfig({}, { dataRoot: directory }) }),
    notifications,
    ...unavailableSupport(database, profileServices),
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => {})))
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

describe('explicit plugin dependencies', () => {
  it('makes injected business services available after boot without owning their resources', async () => {
    const services = fixture(), app = createApp(services)
    apps.push(app)
    await app.ready()
    expect(app.authServices).toBe(services.authServices)
    expect(app.profileServices).toBe(services.profileServices)
    expect(app.joinServices).toBe(services.joinServices)
    expect(app.hasDecorator('invitationServices')).toBe(false)
    expect(app.identityLinkServices).toBe(services.identityLinkServices)
    expect(app.registrationServices).toBe(services.registrationServices)
    expect(app.communityServices).toBe(services.communityServices)
    expect(app.storageServices).toBe(services.storageServices)
    expect(app.notifications).toBe(services.notifications)
    expect(app.clickupServices).toBe(services.clickupServices)
    expect(app.supportServices).toBe(services.supportServices)
    expect(app.hasDecorator('oidcServices')).toBe(true)
    expect(app.oidcServices).toBeUndefined()
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' })
  })

  it('rejects identity when its auth business dependency is absent', async () => {
    const app = Fastify(); apps.push(app)
    app.register(identityPlugin, {})
    await expect(app.ready()).rejects.toThrow()
  })

  it('rejects reversed business registration order', async () => {
    const app = Fastify(), services = fixture(); apps.push(app)
    app.register(identityPlugin, {})
    app.register(authPlugin, { authServices: services.authServices })
    await expect(app.ready()).rejects.toThrow()
  })

  it('rejects a named dependency which does not provide its decorator', async () => {
    const app = Fastify(); apps.push(app)
    app.register(fp(async () => {}, { name: 'business-auth' }))
    app.register(identityPlugin, {})
    await expect(app.ready()).rejects.toThrow()
  })

  it('rejects API registration without the auth request field owner', async () => {
    const app = Fastify(), services = fixture(); apps.push(app)
    app.register(authPlugin, { authServices: services.authServices })
    app.register(profilePlugin, { profileServices: services.profileServices })
    app.register(profileApi)
    await expect(app.ready()).rejects.toThrow()
  })

  it('shares the auth request field with sibling API plugins in their scope', async () => {
    const app = Fastify(), services = fixture(); apps.push(app)
    app.register(authPlugin, { authServices: services.authServices })
    app.register(profilePlugin, { profileServices: services.profileServices })
    app.register(fp(async (scope: ReturnType<typeof createApp>) => {
      await scope.register(authApi)
      await scope.register(profileApi)
      expect(scope.hasRequestDecorator('authSession')).toBe(true)
    }, { name: 'test-api', encapsulate: true }))
    await app.ready()
    expect(app.hasRequestDecorator('authSession')).toBe(false)
  })
})

it('isolates normalization and identity fields from root routes', async () => {
  const app = createApp(fixture()); apps.push(app)
  app.post('/root-probe', async request => ({ body: request.body,
    authField: 'authSession' in request, identityField: 'identityClientId' in request }))
  await app.ready()
  expect(app.hasRequestDecorator('authSession')).toBe(false)
  const body = { email: ' Mixed@EXAMPLE.COM ', nickname: ' Name ' }
  const response = await app.inject({ method: 'POST', url: '/root-probe', payload: body })
  expect(response.json()).toEqual({ body, authField: false, identityField: false })
})

it('keeps the complete Contract route inventory, including implicit HEAD', async () => {
  const app = createApp(fixture()); apps.push(app)
  const routes: { method: string; url: string }[] = []
  app.addHook('onRoute', route => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.push({ method, url: route.url })
  })
  await app.ready()
  const declared = listOperations(readContract())
  const expected = declared.flatMap(({ method, path }) => {
    const url = `/api${path.replace(/\{([^}]+)\}/g, ':$1')}`
    const result = [{ method: method.toUpperCase(), url }]
    // The pre-migration Fastify inventory contains HEAD for every GET, including storage.
    if (method === 'get') result.push({ method: 'HEAD', url })
    return result
  })
  expect(routes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    .toEqual(expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
})

it('rejects duplicate, missing and surplus operation handlers before Glue boot', () => {
  expect(() => mergeOperations({ getHealth: serviceHandlers.getHealth }, { getHealth: serviceHandlers.getHealth })).toThrow()
  const contract = readContract()
  expect(() => assertOperationCoverage(contract, {})).toThrow()
  expect(() => assertOperationCoverage(contract, { ...serviceHandlers, extra: () => {} })).toThrow()
  expect(() => assertOperationCoverage(contract, serviceHandlers)).not.toThrow()
})

it.each(['authServices', 'profileServices', 'storageServices', 'notifications', 'joinServices', 'identityLinkServices', 'registrationServices', 'communityServices', 'clickupServices', 'supportServices'] as const)(
  'rejects absent required %s with its safe diagnostic', async field => {
    const services = fixture(), app = createApp({ ...services, [field]: undefined } as unknown as Parameters<typeof createApp>[0])
    apps.push(app)
    let error: unknown
    try { await app.ready() } catch (failure) { error = failure }
    expect(error).toBeInstanceOf(BusinessPluginLoadError)
    const expectedContext = field === 'clickupServices'
      ? { pluginName: 'business-clickup' }
      : { missingServiceFields: [field] }
    expect(error).toMatchObject({ code: 'BUSINESS_PLUGIN_BOOT_FAILED', context: expectedContext })
    expect(formatBusinessPluginError(error as BusinessPluginLoadError)).toContain(
      field === 'clickupServices' ? 'business-clickup' : field,
    )
  },
)

it('reports a missing identity-link service before deriving its account-rule service', async () => {
  const { externalAccountServices: _unused, ...services } = fixture()
  const app = createApp({ ...services, identityLinkServices: undefined } as unknown as Parameters<typeof createApp>[0])
  apps.push(app)
  let error: unknown
  try { await app.ready() } catch (failure) { error = failure }
  expect(error).toBeInstanceOf(BusinessPluginLoadError)
  expect(error).toMatchObject({ code: 'BUSINESS_PLUGIN_BOOT_FAILED', context: { missingServiceFields: ['identityLinkServices'] } })
})

it('reports a missing account-rule service through the business plugin diagnostic', async () => {
  const { externalAccountServices: _unused, ...services } = fixture()
  Object.defineProperty(services.identityLinkServices, 'externalAccounts', { value: undefined })
  const app = createApp(services)
  apps.push(app)
  let error: unknown
  try { await app.ready() } catch (failure) { error = failure }
  expect(error).toBeInstanceOf(BusinessPluginLoadError)
  expect(error).toMatchObject({ code: 'BUSINESS_PLUGIN_BOOT_FAILED', context: { missingServiceFields: ['externalAccountServices'] } })
})
