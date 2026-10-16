import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  close: vi.fn(async () => {}), check: vi.fn(async () => {}),
  create: vi.fn(), start: vi.fn(() => () => {}),
}))
vi.mock('@server/src/db/client', () => ({ openDatabase: async () => ({ close: state.close }) }))
vi.mock('@server/src/db/schema-check', () => ({ assertDatabaseReady: state.check }))
vi.mock('@server/src/modules/auth/service', () => ({ assertAuthSchemaAvailable: async () => {} }))
vi.mock('@server/src/modules/profile/schema-check', () => ({ assertProfileSchemaAvailable: async () => {} }))
vi.mock('@server/src/domains/community/schema-check', () => ({ assertCommunitySchemaAvailable: async () => {} }))
vi.mock('@server/src/domains/join/applications/schema-check', () => ({ assertJoinSchemaAvailable: async () => {} }))
vi.mock('@server/src/modules/auth/crypto', () => ({ parseAuthCodeHmacKey: () => Buffer.alloc(32) }))
vi.mock('@server/src/create-services', () => ({ createAuthServices: () => ({ authServices: {}, passwordHasher:{} }), createRegistrationServices:()=>({joinServices:{},identityLinkServices:{},registrationServices:{},communityServices:{}}) }))
vi.mock('@server/src/modules/profile/service', () => ({ ProfileService: class {}, avatarDirectory: () => '', publicAvatarBaseUrl: () => '' }))
vi.mock('@server/src/modules/storage/factory', () => ({ createStorageModule: () => ({}) }))
vi.mock('@server/src/modules/storage/config', () => ({ parseStorageConfig: () => ({}), StorageConfigError: class extends Error {} }))
vi.mock('@server/src/http/cors', () => ({ parseCorsAllowedOrigins: () => new Set(), CorsConfigError: class extends Error {} }))
vi.mock('@server/src/modules/identity/config', () => ({ parseIdentityConfig: () => ({ enabled: false }), IdentityConfigError: class extends Error {} }))
vi.mock('@server/src/modules/identity/deployment-binding', () => ({ assertDeploymentBinding: () => {} }))
vi.mock('@server/src/modules/identity/oidc', () => ({ HttpHydraAdmin: class {}, OidcService: class {} }))
vi.mock('@server/src/modules/identity/outbox', () => ({ configuredIdentityOutboxWorker: () => undefined, startIdentityOutboxWorker: () => () => {} }))
vi.mock('@server/src/modules/notifications/factory', () => ({
  deriveNotificationTokenKey: () => Buffer.alloc(32),
  createNotificationModule: () => ({ assertReady: async () => {}, startWorker: state.start }),
}))
vi.mock('@server/src/app', () => ({ createApp: state.create }))
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const Fastify = require('fastify')
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); process.exitCode = 0; vi.stubEnv('SERVER_PORT', '8080');vi.stubEnv('SERVER_PUBLIC_WEB_BASE_URL','http://127.0.0.1:8080'); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); state.close.mockReset().mockResolvedValue(undefined); state.check.mockReset().mockResolvedValue(undefined) })

it.each(['BUSINESS_PLUGIN_DUPLICATE_NAME', 'BUSINESS_PLUGIN_MISSING_DEPENDENCY', 'BUSINESS_PLUGIN_BOOT_FAILED'] as const)('routes %s to actual server output and closes once', async code => {
  const { BusinessPluginLoadError } = await import('@server/src/business-plugin-errors')
  const app = Fastify()
  const error = new BusinessPluginLoadError(code, { pluginName: 'business-probe', missingServiceFields: code === 'BUSINESS_PLUGIN_BOOT_FAILED' ? ['authServices'] : undefined })
  error.message = 'SECRET_MESSAGE'
  app.register(async () => { throw error })
  state.create.mockReturnValue(app)
  await import('@server/src/server')
  const output = vi.mocked(console.error).mock.calls.flat().join(' ')
  expect(output).toContain(code); expect(output).not.toContain('SECRET_MESSAGE'); expect(output).not.toContain('db:migrate')
  if (code === 'BUSINESS_PLUGIN_BOOT_FAILED') expect(output).toContain('authServices')
  expect(state.close).toHaveBeenCalledTimes(1); expect(state.start).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1)
})

it('closes preparation failures before ownership transfer even if close fails', async () => {
  state.check.mockRejectedValue(new Error('SECRET_PREPARATION'))
  state.close.mockRejectedValue(new Error('SECRET_CLEANUP'))
  await import('@server/src/server')
  expect(state.create).not.toHaveBeenCalled(); expect(state.close).toHaveBeenCalledTimes(1)
  expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('SECRET')
  expect(process.exitCode).toBe(1)
})

it('hands synchronous app creation failures to runtime cleanup with no second database close', async () => {
  const { BusinessPluginLoadError } = await import('@server/src/business-plugin-errors')
  state.create.mockImplementation(() => { throw new BusinessPluginLoadError('BUSINESS_PLUGIN_BOOT_FAILED') })
  await import('@server/src/server')
  expect(state.close).toHaveBeenCalledTimes(1); expect(state.start).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})
