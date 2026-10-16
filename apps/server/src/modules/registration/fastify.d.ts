import type { RegistrationService } from './service.js'
declare module 'fastify' {
  interface FastifyInstance {
    registrationServices: RegistrationService
  }
  interface FastifyRequest {
    registrationBrowser?: { token: string; hash: string; production: boolean }
  }
}
