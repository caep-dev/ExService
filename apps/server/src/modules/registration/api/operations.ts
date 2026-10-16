import type { FastifyReply } from 'fastify'
import type { ApiRequest, ApiJsonResult } from '../../../http/handler-types.js'
import { browserContext } from '../../cfx/api/browser-context.js'
import { renewBrowser, requireBrowser } from './browser.js'
export async function requestRegistrationCode(
  request: ApiRequest<'requestRegistrationCode'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'requestRegistrationCode'>> {
  const result = await request.server.registrationServices.requestCode(
    request.body.email,
    requireBrowser(request).hash,
  )
  reply.code(202)
  renewBrowser(request, reply)
  return result
}
export async function verifyRegistrationCode(
  request: ApiRequest<'verifyRegistrationCode'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'verifyRegistrationCode'>> {
  const result = await request.server.registrationServices.verifyCode(
    request.body.challengeId,
    request.body.code,
    requireBrowser(request).hash,
  )
  renewBrowser(request, reply)
  return result
}
export async function completePublicRegistration(
  request: ApiRequest<'completePublicRegistration'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'completePublicRegistration'>> {
  const result = await request.server.registrationServices.complete(
    request.body,
    requireBrowser(request).hash,
  )
  reply.code(result.created ? 201 : 200)
  return result.result
}
export async function signInWithCfx(
  request: ApiRequest<'signInWithCfx'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'signInWithCfx'>> {
  const result = await request.server.registrationServices.signIn(
    browserContext(request),
    request.body.identityTicket,
    requireBrowser(request).hash,
  )
  if (result.kind === 'registration-required') renewBrowser(request, reply)
  return result
}
export const operations = {
  requestRegistrationCode,
  verifyRegistrationCode,
  completePublicRegistration,
  signInWithCfx,
} as const
