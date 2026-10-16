import type { FastifyPluginAsync, onRequestHookHandler, onResponseHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { CfxError } from '../errors.js'
import { browserContext, browserToken, checkRawQuery, checkSource } from './browser-context.js'

const operations = new Set(['createCfxAttempt', 'completeCfxManualAttempt', 'receiveCfxCallback', 'getCfxAttempt', 'cancelCfxAttempt'])
const plugin: FastifyPluginAsync = async app => {
  app.getDecorator('cfxServices')
  app.decorateRequest('cfxContext', undefined)
  app.decorateRequest('cfxSignal', undefined)
  app.decorateRequest('cfxCleanup', undefined)
  app.addHook('onRoute', route => {
    const id = (route.schema as { operationId?: string } | undefined)?.operationId
    if (!id || !operations.has(id)) return
    if (route.method === 'POST') route.bodyLimit = 4096
    const guard: onRequestHookHandler = async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
      const callback = id === 'receiveCfxCallback'
      // Fastify exposes HEAD for GET routes; callbacks must not consume authorization through it.
      if (callback && request.method === 'HEAD') {
        reply.header('Allow', 'GET')
        throw Object.assign(new Error('GET required.'), { statusCode: 405 })
      }
      const config = request.server.cfxServices.config
      checkSource(request, config, callback)
      if (id === 'completeCfxManualAttempt' && config.enabled && config.mode !== 'manual') throw new CfxError('CFX_FLOW_UNAVAILABLE')
      checkRawQuery(request, callback)
      browserToken(request, config)
      if (id !== 'createCfxAttempt') request.cfxContext = browserContext(request)
      if (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw Object.assign(new Error('JSON required.'), { statusCode: 415 })
      }
      if (request.method !== 'POST' && (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])) {
        throw Object.assign(new Error('Unexpected request body.'), { statusCode: 400 })
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      const responseClose = () => { if (!reply.raw.writableFinished) abort() }
      request.raw.once('aborted', abort); reply.raw.once('close', responseClose)
      request.cfxSignal = controller.signal
      request.cfxCleanup = () => { request.raw.off('aborted', abort); reply.raw.off('close', responseClose) }
      if (request.raw.aborted) abort()
    }
    const cleanup: onResponseHookHandler = async request => { request.cfxCleanup?.() }
    route.onRequest = [guard, ...(route.onRequest === undefined ? [] : Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest])]
    route.onResponse = [...(route.onResponse === undefined ? [] : Array.isArray(route.onResponse) ? route.onResponse : [route.onResponse]), cleanup]
  })
}
export default fp(plugin, { name: 'api-cfx', fastify: '5.x', dependencies: ['business-cfx'], decorators: { fastify: ['cfxServices'] } })
