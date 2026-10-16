import type { BusinessServices } from './business-services.js'

const messages = {
  BUSINESS_PLUGIN_ENTRY_CONFLICT: '业务插件入口扩展冲突。',
  BUSINESS_PLUGIN_INVALID_ENTRY: '业务插件入口或元信息无效。',
  BUSINESS_PLUGIN_DUPLICATE_NAME: '业务插件名称重复。',
  BUSINESS_PLUGIN_MISSING_DEPENDENCY: '业务插件依赖缺失。',
  BUSINESS_PLUGIN_INVALID_DEPENDENCY_DIRECTION: '公共模块不能依赖具体业务。',
  BUSINESS_PLUGIN_CYCLIC_DEPENDENCY: '业务插件依赖存在循环。',
  BUSINESS_PLUGIN_IMPORT_FAILED: '业务插件入口导入失败。',
  BUSINESS_PLUGIN_BOOT_FAILED: '业务插件启动失败。',
} as const
export type BusinessPluginErrorCode = keyof typeof messages
export type BusinessPluginStage = 'modules' | 'domains'
export const businessPluginNamePattern = /^business-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const businessDirectoryPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const serviceFields: readonly (keyof BusinessServices)[] = [
  'authServices', 'profileServices', 'joinServices', 'identityLinkServices', 'registrationServices', 'communityServices',
  'oidcServices', 'storageServices', 'notifications', 'clickupServices', 'supportServices', 'cfxServices', 'externalAccountServices',
]
interface ErrorContext {
  stage?: BusinessPluginStage
  location?: string
  pluginName?: string
  dependencyName?: string
  missingServiceFields?: readonly (keyof BusinessServices)[]
}

function safeContext(context: ErrorContext): Readonly<ErrorContext> {
  return Object.freeze({
    stage: context.stage === 'modules' || context.stage === 'domains' ? context.stage : undefined,
    location: typeof context.location === 'string' && /^(?:modules|domains)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/plugin\.(?:ts|js)$/.test(context.location)
      ? context.location : undefined,
    pluginName: typeof context.pluginName === 'string' && businessPluginNamePattern.test(context.pluginName) ? context.pluginName : undefined,
    dependencyName: typeof context.dependencyName === 'string' && businessPluginNamePattern.test(context.dependencyName) ? context.dependencyName : undefined,
    missingServiceFields: Array.isArray(context.missingServiceFields)
      ? Object.freeze([...new Set(context.missingServiceFields.filter(field => serviceFields.includes(field)))]) : undefined,
  })
}

export class BusinessPluginLoadError extends Error {
  readonly context: Readonly<ErrorContext>
  constructor(readonly code: BusinessPluginErrorCode, context: ErrorContext = {}) {
    super(messages[code])
    this.name = 'BusinessPluginLoadError'
    this.context = safeContext(context)
  }
}

/** Revalidate at the output boundary; never interpolate Error.message/cause/stack. */
export function formatBusinessPluginError(error: BusinessPluginLoadError): string {
  const context = safeContext(error.context)
  const fields = context.missingServiceFields
  const detail = fields?.length ? `缺少业务服务：${fields.join('、')}。` : messages[error.code] ?? messages.BUSINESS_PLUGIN_BOOT_FAILED
  const position = [context.stage, context.location, context.pluginName, context.dependencyName].filter(Boolean).join(' ')
  const code = Object.hasOwn(messages, error.code) ? error.code : 'BUSINESS_PLUGIN_BOOT_FAILED'
  return `[server] ${code}：${detail}${position ? ` (${position})` : ''}`
}

export function requireBusinessServices(pluginName: string, fields: Partial<Record<keyof BusinessServices, unknown>>): void {
  const missingServiceFields = serviceFields.filter(field => Object.hasOwn(fields, field) && fields[field] === undefined)
  if (missingServiceFields.length) throw new BusinessPluginLoadError('BUSINESS_PLUGIN_BOOT_FAILED', { pluginName, missingServiceFields })
}
