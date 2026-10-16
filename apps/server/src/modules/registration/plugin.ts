import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { RegistrationService } from './service.js'
import { requireBusinessServices } from '../../business-plugin-errors.js'
const plugin: FastifyPluginAsync<{ registrationServices: RegistrationService }> = async (app, options) => {
  requireBusinessServices('business-registration', { registrationServices: options.registrationServices })
  app.decorate('registrationServices', options.registrationServices)
  app.addHook('onReady', () => options.registrationServices.start())
  app.addHook('preClose', () => options.registrationServices.close())
  app.addHook('onClose', () => options.registrationServices.close())
}
export default fp(plugin, {
  name: 'business-registration',
  fastify: '5.x',
  dependencies: ['business-auth', 'business-cfx', 'business-identity-links', 'business-external-accounts'],
  decorators: { fastify: ['authServices', 'cfxServices', 'identityLinkServices', 'externalAccountServices'] },
})
