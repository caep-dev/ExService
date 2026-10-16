import type { ApiRequest, ApiJsonResult } from '@server/src/http/handler-types.js'
import type { FastifyReply } from 'fastify'
import { requireSession } from '@server/src/modules/auth/api/handlers.js'

export async function updateCurrentUser(request: ApiRequest<'updateCurrentUser'>, reply: FastifyReply): Promise<ApiJsonResult<'updateCurrentUser'>> {
  void reply.header('Cache-Control', 'no-store')
  const session = requireSession(request)
  return request.server.profileServices.update(session.userId, request.body,
    tx => request.server.authServices.assertSessionCurrent(session, tx, true))
}

export async function uploadCurrentUserAvatar(request: ApiRequest<'uploadCurrentUserAvatar'>, reply: FastifyReply): Promise<ApiJsonResult<'uploadCurrentUserAvatar'>> {
  void reply.header('Cache-Control', 'no-store')
  const session = requireSession(request)
  return request.server.profileServices.upload(session.userId, request.body,
    tx => request.server.authServices.assertSessionCurrent(session, tx, true))
}

export async function getAvatarImage(request: ApiRequest<'getAvatarImage'>, reply: FastifyReply): Promise<Buffer> {
  void reply.header('Cache-Control', 'no-store')
  void reply.type('image/webp')
  const { avatarId } = request.params
  return request.server.profileServices.readAvatar(avatarId)
}
