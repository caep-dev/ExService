import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { BusinessServices } from './business-services.js'
import businessPlugins from './business-plugins.js'
import httpFoundation from './http/foundation.js'
import websiteApi from './http/plugin.js'
import { createCfxServices } from './modules/cfx/service.js'
import { safeRequestLogger } from './http/shared/request-logging.js'

export { API_PREFIX, OPENAPI_PATH } from './contract/document.js'
export { serviceHandlers } from './http/service-handlers.js'

export interface CreateAppOptions extends BusinessServices {
  identityKeys?: { clients: Record<string, string>; bootstrapKey?: string };
  publicOrigin?: string;
  production?: boolean;
  /**
   * 测试中保持静默；`server.ts` 开启日志，以便用 requestId 关联日志与响应。
   */
  logger?: FastifyServerOptions["logger"];
  /** 由监听入口显式限定可信代理；默认不信任客户端转发头。 */
  trustProxy?: FastifyServerOptions["trustProxy"];
  corsAllowedOrigins?: ReadonlySet<string>;
  /**
   * 请求 ID 生成器；缺省沿用 Fastify 的自增生成器。
   *
   * `requestIdHeader` 恒为 false，传入的 `x-request-id` 永不被采信；
   * 这个选项只让测试把请求 ID 固定成确定值，便于逐字节比较错误 envelope。
   */
  genReqId?: FastifyServerOptions["genReqId"];
}

/** Create synchronously; service decorators and API routes become available after Fastify boot. */
export function createApp({
  authServices, profileServices, joinServices, identityLinkServices, externalAccountServices, registrationServices, communityServices, storageServices, notifications, clickupServices, supportServices,
  cfxServices = createCfxServices({ config: { enabled: false } }),
  identityKeys, oidcServices, publicOrigin = 'http://127.0.0.1:8080', production = false, logger = false, trustProxy = false, corsAllowedOrigins = new Set(), genReqId,
}: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    logger: safeRequestLogger(logger), trustProxy, requestIdHeader: false, bodyLimit: 4 * 1024 * 1024, genReqId,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  })
  app.register(businessPlugins, Object.freeze({
    authServices, profileServices, joinServices, identityLinkServices,
    externalAccountServices: externalAccountServices ?? identityLinkServices?.externalAccounts,
    registrationServices, communityServices, storageServices, notifications, clickupServices, supportServices, oidcServices, cfxServices,
  }))
  app.register(httpFoundation, { origins: corsAllowedOrigins })
  app.register(websiteApi, { identityKeys, publicOrigin, production })
  return app
}
