import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { browserContext, browserToken } from '../../cfx/api/browser-context.js'
import { CfxError } from '../../cfx/errors.js'
import { checkOrigin, validateOrigin, type TrustedBrowserOptions } from './source.js'
const ids = new Set([
  'getMyIdentityLinks',
  'createMyCfxLinkAttempt',
  'linkMyCfxIdentity',
  'unlinkMyCfxIdentity',
])
const plugin: FastifyPluginAsync<TrustedBrowserOptions> = async (app, options) => {
  validateOrigin(options)
  app.addHook('onRoute', (route) => {
    const id = (route.schema as { operationId?: string } | undefined)?.operationId
    if (!id || !ids.has(id)) return
    if (route.method === 'POST') route.bodyLimit = 4096
    const guard: onRequestHookHandler = async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
      checkOrigin(request, options.publicOrigin)
      if ((request.raw.url ?? '').includes('?'))
        throw Object.assign(new Error('Unexpected query'), { statusCode: 400 })
      if (request.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
          throw Object.assign(new Error('JSON required'), { statusCode: 415 })
        if (!request.server.cfxServices.config.enabled) throw new CfxError('CFX_DISABLED')
        browserToken(request, request.server.cfxServices.config)
        if (id === 'linkMyCfxIdentity') browserContext(request)
      } else if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])
        throw Object.assign(new Error('Unexpected body'), { statusCode: 400 })
    }
    route.onRequest = [
      guard,
      ...(route.onRequest === undefined
        ? []
        : Array.isArray(route.onRequest)
          ? route.onRequest
          : [route.onRequest]),
    ]
  })
}
export default fp(plugin, {
  name: 'api-identity-links',
  fastify: '5.x',
  dependencies: ['business-identity-links'],
  decorators: { fastify: ['identityLinkServices', 'cfxServices'] },
})
