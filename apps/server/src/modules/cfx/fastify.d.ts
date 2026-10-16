import type { CfxServices } from './types.js'
declare module 'fastify' { interface FastifyInstance { cfxServices: CfxServices } }
