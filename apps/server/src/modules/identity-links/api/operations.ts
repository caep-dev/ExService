import type { FastifyReply } from 'fastify'
import type { ApiRequest, ApiJsonResult } from '../../../http/handler-types.js'
import { requireSession } from '../../auth/api/handlers.js'
import { browserContext, browserToken, cookieName } from '../../cfx/api/browser-context.js'
import { CfxError } from '../../cfx/errors.js'
export async function getMyIdentityLinks(
  request: ApiRequest<'getMyIdentityLinks'>,
): Promise<ApiJsonResult<'getMyIdentityLinks'>> {
  return request.server.identityLinkServices.list(requireSession(request))
}
export async function createMyCfxLinkAttempt(
  request: ApiRequest<'createMyCfxLinkAttempt'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'createMyCfxLinkAttempt'>> {
  const config = request.server.cfxServices.config
  const controller = new AbortController(),
    abort = () => controller.abort()
  const responseClose = () => {
    if (!reply.raw.writableFinished) abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', responseClose)
  if (request.raw.aborted) abort()
  try {
    const result = await request.server.identityLinkServices.begin(requireSession(request), {
      bindingToken: browserToken(request, config),
      clientIp: request.ip,
      signal: controller.signal,
    })
    reply
      .code(201)
      .header(
        'Set-Cookie',
        `${cookieName(config)}=${result.cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1200${config.enabled && config.mode === 'redirect' ? '; Secure' : ''}`,
      )
    return result.response
  } finally {
    request.raw.off('aborted', abort)
    reply.raw.off('close', responseClose)
  }
}
export async function linkMyCfxIdentity(
  request: ApiRequest<'linkMyCfxIdentity'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'linkMyCfxIdentity'>> {
  const result = await request.server.identityLinkServices.link(
    requireSession(request),
    browserContext(request),
    request.body.attemptId,
    request.body.identityTicket,
  )
  reply.code(201)
  return result
}
export async function unlinkMyCfxIdentity(
  request: ApiRequest<'unlinkMyCfxIdentity'>,
): Promise<ApiJsonResult<'unlinkMyCfxIdentity'>> {
  return request.server.identityLinkServices.unlink(requireSession(request))
}
export async function cancelCfxAttempt(
  request: ApiRequest<'cancelCfxAttempt'>,
): Promise<ApiJsonResult<'cancelCfxAttempt'>> {
  if (!request.cfxContext) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
  return request.server.identityLinkServices.cancelCfxAttempt(request.cfxContext, request.params.id)
}
export const operations = {
  getMyIdentityLinks,
  createMyCfxLinkAttempt,
  linkMyCfxIdentity,
  unlinkMyCfxIdentity,
  cancelCfxAttempt,
} as const
