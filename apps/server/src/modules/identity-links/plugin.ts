import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { IdentityLinkService } from './service.js'
import { requireBusinessServices } from '../../business-plugin-errors.js'
const plugin: FastifyPluginAsync<{ identityLinkServices: IdentityLinkService }> = async (app, options) => {
  requireBusinessServices('business-identity-links', { identityLinkServices: options.identityLinkServices })
  app.decorate('identityLinkServices', options.identityLinkServices)
  app.addHook('onReady', () => options.identityLinkServices.start())
  app.addHook('preClose', () => options.identityLinkServices.close())
  app.addHook('onClose', () => options.identityLinkServices.close())
}
export default fp(plugin, {
  name: 'business-identity-links',
  fastify: '5.x',
  dependencies: ['business-auth', 'business-cfx', 'business-external-accounts'],
  decorators: { fastify: ['authServices', 'cfxServices', 'externalAccountServices'] },
})
