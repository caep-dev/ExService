import { expect, it, vi } from 'vitest'
import { parseCfxConfig } from '@server/src/modules/cfx/config'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { requireBusinessServices } from '@server/src/business-plugin-errors'

it('is disabled without origin/environment and creates no timer, crypto or network work', async () => {
  const fetch = vi.fn(), generateKeys = vi.fn(), timer = vi.spyOn(globalThis, 'setInterval')
  const service = createCfxServices({ config: parseCfxConfig({}), fetch, generateKeys })
  service.start()
  await expect(service.begin({ clientIp: '1' })).rejects.toMatchObject({ code: 'CFX_DISABLED' })
  expect(fetch).not.toHaveBeenCalled(); expect(generateKeys).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled()
  await service.close(); timer.mockRestore()
})

it.each([
  { CFX_ENABLED: 'yes' },
  { CFX_ENABLED: 'true' },
  { CFX_ENABLED: 'true', NODE_ENV: 'test' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'http://website.example' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://127.0.0.1' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://localhost.' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://login.localhost.' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://[::ffff:127.0.0.1]' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://user:password@website.example' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://website.example/path' },
  { CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://website.example?query' },
  { CFX_ENABLED: 'true', NODE_ENV: 'development', SERVER_PUBLIC_WEB_BASE_URL: 'http://elsewhere.example' },
  { CFX_ENABLED: 'true', NODE_ENV: 'development', SERVER_PUBLIC_WEB_BASE_URL: 'http://localhost', CFX_APPLICATION_NAME: '\u0000bad' },
])('rejects invalid enabled configuration without printing input values %j', input => {
  expect(() => parseCfxConfig(input)).toThrow(/Invalid Cfx configuration:/)
})

it('uses explicit environment and configured origin, with Unicode name limits', () => {
  const config = parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: 'production', SERVER_PUBLIC_WEB_BASE_URL: 'https://website.example/', CFX_APPLICATION_NAME: '😀'.repeat(80) })
  expect(config).toMatchObject({ enabled: true, mode: 'redirect', publicOrigin: 'https://website.example' })
  expect(Object.isFrozen(config)).toBe(true)
})

it('starts exactly one unref sweep and stops it on idempotent close', async () => {
  vi.useFakeTimers()
  const service = createCfxServices({ config: parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: 'development', SERVER_PUBLIC_WEB_BASE_URL: 'http://localhost:8080' }) })
  expect(vi.getTimerCount()).toBe(0)
  service.start(); service.start()
  expect(vi.getTimerCount()).toBe(1)
  const first = service.close(); expect(service.close()).toBe(first); await first
  expect(vi.getTimerCount()).toBe(0)
  service.start(); expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it('diagnoses a missing injected Cfx service at the business boundary', () => {
  expect(() => requireBusinessServices('business-cfx', { cfxServices: undefined })).toThrow(expect.objectContaining({
    code: 'BUSINESS_PLUGIN_BOOT_FAILED', context: expect.objectContaining({ missingServiceFields: ['cfxServices'] }),
  }))
})
