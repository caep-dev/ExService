export type CfxConfig = Readonly<{ enabled: false } | {
  enabled: true; mode: 'manual' | 'redirect'; publicOrigin: string; applicationName: string
}>

export class CfxConfigError extends Error {
  constructor(key: string) { super(`Invalid Cfx configuration: ${key}`) }
}

export function parseCfxConfig(environment: Record<string, string | undefined> = process.env): CfxConfig {
  const enabled = environment.CFX_ENABLED
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new CfxConfigError('CFX_ENABLED')
  if (enabled !== 'true') return Object.freeze({ enabled: false })
  const applicationName = (environment.CFX_APPLICATION_NAME ?? 'ExWebsite').trim()
  if (!applicationName || [...applicationName].length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(applicationName)) throw new CfxConfigError('CFX_APPLICATION_NAME')
  const mode = environment.NODE_ENV === 'development' ? 'manual' : environment.NODE_ENV === 'production' ? 'redirect' : undefined
  if (!mode) throw new CfxConfigError('NODE_ENV')
  const value = environment.SERVER_PUBLIC_WEB_BASE_URL
  let url: URL
  try { url = new URL(value!) } catch { throw new CfxConfigError('SERVER_PUBLIC_WEB_BASE_URL') }
  const hostname = url.hostname.replace(/\.+$/, '')
  const local = hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) ||
    hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/i.test(hostname)
  if (!/^https?:\/\/[^/\s\\]+\/?$/.test(value ?? '') || url.username || url.password || url.search || url.hash ||
      (mode === 'manual' ? url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
        : url.protocol !== 'https:' || local)) throw new CfxConfigError('SERVER_PUBLIC_WEB_BASE_URL')
  return Object.freeze({ enabled: true, mode, publicOrigin: url.origin, applicationName })
}

export const CFX_LIMITS = Object.freeze({ attemptMs: 600_000, resultMs: 300_000, terminalMs: 300_000,
  bindingMs: 1_200_000, bindings: 1024, attempts: 256, activePerBinding: 3, generation: 2, processing: 4,
  requestMs: 20_000, processingMs: 40_000, responseBytes: 1024 * 1024, counters: 2048, windowMs: 60_000 })
