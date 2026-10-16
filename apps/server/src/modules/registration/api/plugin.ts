import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { browserContext } from '../../cfx/api/browser-context.js'
import { CfxError } from '../../cfx/errors.js'
import { checkOrigin, registrationBrowser, validateOrigin, type RegistrationApiOptions } from './browser.js'
const ids = new Set([
  'requestRegistrationCode',
  'verifyRegistrationCode',
  'completePublicRegistration',
  'signInWithCfx',
])
const plugin: FastifyPluginAsync<RegistrationApiOptions> = async (app, options) => {
  validateOrigin(options)
  app.decorateRequest('registrationBrowser', undefined)
  app.addHook('onRoute', (route) => {
    const id = (route.schema as { operationId?: string } | undefined)?.operationId
    if (!id || !ids.has(id)) return
    route.bodyLimit = 4096
    const guard: onRequestHookHandler = async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
      checkOrigin(request, options.publicOrigin)
      if ((request.raw.url ?? '').includes('?'))
        throw Object.assign(new Error('Unexpected query'), { statusCode: 400 })
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
        throw Object.assign(new Error('JSON required'), { statusCode: 415 })
      request.server.registrationServices.limitIp(request.ip)
      request.registrationBrowser = registrationBrowser(
        request,
        options.production,
        id === 'requestRegistrationCode' || id === 'signInWithCfx',
      )
      if (id === 'signInWithCfx') {
        if (!request.server.cfxServices.config.enabled) throw new CfxError('CFX_DISABLED')
        browserContext(request)
      }
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
  name: 'api-registration',
  fastify: '5.x',
  dependencies: ['business-registration'],
  decorators: { fastify: ['registrationServices', 'cfxServices'] },
})
