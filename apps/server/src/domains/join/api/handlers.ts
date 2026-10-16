import type {
  ApiRequest,
  ApiTransportRequest,
  ApiJsonResult,
} from '@server/src/http/handler-types.js'
import type { FastifyReply } from 'fastify'
import { requireSession } from '../../../modules/auth/api/handlers.js'
import { getJoinProofs, type JoinTransportBody } from './transport.js'
const noStore = (reply: FastifyReply) => {
  void reply.header('Cache-Control', 'no-store')
}
export async function submitJoinApplication(
  request: ApiTransportRequest<'submitJoinApplication', JoinTransportBody>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'submitJoinApplication'>> {
  noStore(reply)
  const result = await request.server.joinServices.submit(
    requireSession(request),
    request.params.communityId,
    request.body.application,
    getJoinProofs(request),
  )
  void reply.code(202)
  return result
}
export async function listJoinApplications(
  request: ApiRequest<'listJoinApplications'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'listJoinApplications'>> {
  noStore(reply)
  return request.server.joinServices.list(
    requireSession(request),
    request.params.communityId,
    request.query,
  )
}
export async function getJoinApplication(
  request: ApiRequest<'getJoinApplication'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'getJoinApplication'>> {
  noStore(reply)
  return request.server.joinServices.get(
    requireSession(request),
    request.params.communityId,
    request.params.applicationId,
  )
}
export async function approveJoinApplication(
  request: ApiRequest<'approveJoinApplication'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'approveJoinApplication'>> {
  noStore(reply)
  return request.server.joinServices.approve(
    requireSession(request),
    request.params.communityId,
    request.params.applicationId,
  )
}
export async function rejectJoinApplication(
  request: ApiRequest<'rejectJoinApplication'>,
  reply: FastifyReply,
): Promise<ApiJsonResult<'rejectJoinApplication'>> {
  noStore(reply)
  return request.server.joinServices.reject(
    requireSession(request),
    request.params.communityId,
    request.params.applicationId,
  )
}
export async function downloadJoinApplicationAttachment(
  request: ApiRequest<'downloadJoinApplicationAttachment'>,
  reply: FastifyReply,
): Promise<Buffer> {
  noStore(reply)
  const { communityId, applicationId, attachmentId } = request.params
  const result = await request.server.joinServices.download(
    requireSession(request),
    communityId,
    applicationId,
    attachmentId,
  )
  const ascii = result.originalName.replace(/[^A-Za-z0-9._ -]/g, '_') || 'attachment',
    encoded = encodeURIComponent(result.originalName).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    )
  void reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Length', String(result.byteLength))
  return result.bytes
}
