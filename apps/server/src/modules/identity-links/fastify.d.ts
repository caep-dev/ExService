import type { IdentityLinkService } from './service.js'
declare module 'fastify' {
  interface FastifyInstance {
    identityLinkServices: IdentityLinkService
  }
}
