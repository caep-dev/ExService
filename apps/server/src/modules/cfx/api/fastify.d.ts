import type { CfxBrowserContext } from '../types.js'
declare module 'fastify' {
  interface FastifyRequest {
    cfxContext?: CfxBrowserContext
    cfxSignal?: AbortSignal
    cfxCleanup?: () => void
  }
}
