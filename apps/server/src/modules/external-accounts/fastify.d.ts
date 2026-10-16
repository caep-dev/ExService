import type { ExternalAccountService } from './service.js'
declare module 'fastify' {
  interface FastifyInstance {
    externalAccountServices: ExternalAccountService
  }
}
