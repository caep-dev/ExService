import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { CfxServices } from './types.js'
import { requireBusinessServices } from '../../business-plugin-errors.js'

const plugin: FastifyPluginAsync<{ cfxServices: CfxServices }> = async (app, options) => {
  requireBusinessServices('business-cfx', { cfxServices: options.cfxServices })
  const service = options.cfxServices
  app.decorate('cfxServices', service)
  app.addHook('preClose', async () => { await service.close() })
  app.addHook('onClose', async () => { await service.close() })
  app.addHook('onReady', async () => { service.start() })
}
export default fp(plugin, { name: 'business-cfx', fastify: '5.x' })
