import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { registerJoinTransport } from './transport.js'
import { operations } from './operations.js'
import {
  checkOrigin,
  validateOrigin,
  type TrustedBrowserOptions,
} from '../../../modules/identity-links/api/source.js'
const plugin: FastifyPluginAsync<TrustedBrowserOptions> = async (app, options) => {
  validateOrigin(options)
  app.getDecorator('joinServices')
  app.addHook('onRoute', (route) => {
    const id = (route.schema as { operationId?: string } | undefined)?.operationId
    if (!id || !Object.hasOwn(operations, id)) return
    if (route.method === 'POST' && id !== 'submitJoinApplication') route.bodyLimit = 4096
    const guard: onRequestHookHandler = async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
      checkOrigin(request, options.publicOrigin)
      if (id !== 'listJoinApplications' && (request.raw.url ?? '').includes('?'))
        throw new ObjectRequestError(400)
      if (
        id !== 'submitJoinApplication' &&
        (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'])
      )
        throw new ObjectRequestError(400)
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
  registerJoinTransport(app)
}
class ObjectRequestError extends Error {
  constructor(readonly statusCode: number) {
    super('Unexpected request shape')
  }
}
export default fp(plugin, {
  name: 'api-join',
  fastify: '5.x',
  dependencies: ['business-join', 'api-auth'],
  decorators: {
    fastify: ['joinServices', 'authServices'],
    request: ['authSession'],
  },
})
