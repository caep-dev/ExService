import type { FastifyReply } from 'fastify'
import type { ApiRequest, ApiJsonResult } from '../../../http/handler-types.js'
import { requireSession } from '../../auth/api/handlers.js'
const noStore = (reply: FastifyReply) => { reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff') }
export async function listCommunities(request:ApiRequest<'listCommunities'>,reply:FastifyReply):Promise<ApiJsonResult<'listCommunities'>> {
  noStore(reply);return request.server.communityServices.list({limit:request.query.limit??20,offset:request.query.offset??0})
}
export async function getCommunity(request:ApiRequest<'getCommunity'>,reply:FastifyReply):Promise<ApiJsonResult<'getCommunity'>> {
  noStore(reply);return request.server.communityServices.get(request.params.communityId)
}
export async function listMyCommunityStatuses(request:ApiRequest<'listMyCommunityStatuses'>,reply:FastifyReply):Promise<ApiJsonResult<'listMyCommunityStatuses'>> {
  noStore(reply);return request.server.communityServices.listMyStatuses(requireSession(request),{limit:request.query.limit??20,offset:request.query.offset??0})
}
export async function getMyCommunityStatus(request:ApiRequest<'getMyCommunityStatus'>,reply:FastifyReply):Promise<ApiJsonResult<'getMyCommunityStatus'>> {
  noStore(reply);return request.server.communityServices.myStatus(requireSession(request),request.params.communityId)
}
export async function getMyCommunityReviewAccess(request:ApiRequest<'getMyCommunityReviewAccess'>,reply:FastifyReply):Promise<ApiJsonResult<'getMyCommunityReviewAccess'>> {
  noStore(reply);return request.server.communityServices.reviewAccess(requireSession(request))
}
export async function createCommunity(request:ApiRequest<'createCommunity'>,reply:FastifyReply):Promise<ApiJsonResult<'createCommunity'>> {
  noStore(reply);const result=await request.server.communityServices.create(requireSession(request),request.body);reply.code(201);return result
}
export async function updateCommunity(request:ApiRequest<'updateCommunity'>,reply:FastifyReply):Promise<ApiJsonResult<'updateCommunity'>> {
  noStore(reply);return request.server.communityServices.update(requireSession(request),request.params.communityId,request.body)
}
export async function listCommunityReviewers(request:ApiRequest<'listCommunityReviewers'>,reply:FastifyReply):Promise<ApiJsonResult<'listCommunityReviewers'>> {
  noStore(reply);return request.server.communityServices.listReviewers(requireSession(request),request.params.communityId,{limit:request.query.limit??20,offset:request.query.offset??0})
}
export async function grantCommunityReviewer(request:ApiRequest<'grantCommunityReviewer'>,reply:FastifyReply):Promise<ApiJsonResult<'grantCommunityReviewer'>> {
  noStore(reply);return request.server.communityServices.grantReviewer(requireSession(request),request.params.communityId,request.params.userId)
}
export async function revokeCommunityReviewer(request:ApiRequest<'revokeCommunityReviewer'>,reply:FastifyReply):Promise<ApiJsonResult<'revokeCommunityReviewer'>> {
  noStore(reply);return request.server.communityServices.revokeReviewer(requireSession(request),request.params.communityId,request.params.userId)
}
