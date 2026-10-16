import type { JoinService } from './applications/service.js'
declare module 'fastify' {
  interface FastifyInstance {
    joinServices: JoinService
  }
}
