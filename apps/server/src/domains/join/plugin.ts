import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { JoinService } from './applications/service.js'
import { requireBusinessServices } from '../../business-plugin-errors.js'
export interface JoinPluginOptions {
  joinServices: JoinService
}
const plugin: FastifyPluginAsync<JoinPluginOptions> = async (app, options) => {
  requireBusinessServices('business-join', {
    joinServices: options.joinServices,
  })
  app.decorate('joinServices', options.joinServices)
}
export default fp(plugin, {
  name: 'business-join',
  fastify: '5.x',
  dependencies: ['business-auth', 'business-communities', 'business-notifications'],
})
