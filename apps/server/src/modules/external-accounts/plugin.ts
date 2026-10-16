import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { requireBusinessServices } from '../../business-plugin-errors.js'
import type { ExternalAccountService } from './service.js'

const plugin: FastifyPluginAsync<{ externalAccountServices: ExternalAccountService }> = async (app, options) => {
  requireBusinessServices('business-external-accounts', { externalAccountServices: options.externalAccountServices })
  app.decorate('externalAccountServices', options.externalAccountServices)
}

export default fp(plugin, {
  name: 'business-external-accounts',
  fastify: '5.x',
  dependencies: ['business-auth', 'business-cfx'],
  decorators: { fastify: ['authServices', 'cfxServices'] },
})
