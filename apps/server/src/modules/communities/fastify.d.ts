import type { CommunityService } from './service.js'
declare module 'fastify' { interface FastifyInstance { communityServices: CommunityService } }
export {}
