import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiRequest, ApiJsonResult } from '../../../http/handler-types.js'
import { browserToken, cookieName } from './browser-context.js'
import { CfxError } from '../errors.js'

function context(request: FastifyRequest) {
  if (!request.cfxContext) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
  return request.cfxContext
}
export async function createCfxAttempt(request: ApiRequest<'createCfxAttempt'>, reply: FastifyReply): Promise<ApiJsonResult<'createCfxAttempt'>> {
  const service = request.server.cfxServices
  const result = await service.begin({ bindingToken: browserToken(request, service.config), clientIp: request.ip, signal: request.cfxSignal })
  reply.code(201).header('Set-Cookie', `${cookieName(service.config)}=${result.cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1200${service.config.enabled && service.config.mode === 'redirect' ? '; Secure' : ''}`)
  return result.response
}
export async function completeCfxManualAttempt(request: ApiRequest<'completeCfxManualAttempt'>): Promise<ApiJsonResult<'completeCfxManualAttempt'>> {
  return request.server.cfxServices.complete({ context: context(request), attemptId: request.params.id, payload: request.body.payload, source: 'manual', signal: request.cfxSignal })
}
export async function receiveCfxCallback(request: ApiRequest<'receiveCfxCallback'>): Promise<ApiJsonResult<'receiveCfxCallback'>> {
  return request.server.cfxServices.complete({ context: context(request), attemptId: request.query.attemptId, payload: request.query.payload, source: 'redirect', signal: request.cfxSignal })
}
export async function getCfxAttempt(request: ApiRequest<'getCfxAttempt'>): Promise<ApiJsonResult<'getCfxAttempt'>> {
  return request.server.cfxServices.inspect(context(request), request.params.id)
}
export const operations = { createCfxAttempt, completeCfxManualAttempt, receiveCfxCallback, getCfxAttempt } as const
