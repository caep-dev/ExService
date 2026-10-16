import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { requireBusinessServices } from '../../business-plugin-errors.js'
import type { CommunityService } from './service.js'
const plugin: FastifyPluginAsync<{ communityServices: CommunityService }> = async (app, options) => {
  requireBusinessServices('business-communities', {communityServices:options.communityServices})
  app.getDecorator('authServices'); app.getDecorator('identityLinkServices')
  app.decorate('communityServices',options.communityServices)
}
export default fp(plugin,{name:'business-communities',fastify:'5.x',dependencies:['business-auth','business-identity-links'],decorators:{fastify:['authServices','identityLinkServices']}})
