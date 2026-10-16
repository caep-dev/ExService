import {afterEach,expect,it} from 'vitest'
import Fastify from '../../apps/server/node_modules/fastify/fastify.js'
import type {FastifyRequest} from '../../apps/server/node_modules/fastify'
import fp from '../../apps/server/node_modules/fastify-plugin'
import glue from '../../apps/server/node_modules/fastify-openapi-glue/index.js'
import {fixture} from '../registration/fixture'
import {registerErrorHandlers} from '@server/src/errors'
import {authenticateBearer} from '@server/src/modules/auth/api/security'
import authApi from '@server/src/modules/auth/api/plugin'
import {ProfileService} from '@server/src/modules/profile/service'
import profilePlugin from '@server/src/modules/profile/plugin'
import {CommunityService} from '@server/src/modules/communities/service'
import communitiesPlugin from '@server/src/modules/communities/plugin'
import communitiesApi from '@server/src/modules/communities/api/plugin'
import {operations} from '@server/src/modules/communities/api/operations'
import {compileComponentSchema,readContract} from '../helpers/contract'
import type {OperationId,TypedApiHandler} from '@server/src/http/handler-types'
const closers:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close()})
it('checks all ten community operations against real Glue HTTP and raw handler output, with explicit review grants',async()=>{
  const f=await fixture({disabled:true});closers.push(()=>f.close())
  const service=new CommunityService({db:f.db,authServices:f.auth,identityLinkServices:f.links})
  const app=Fastify({ajv:{customOptions:{coerceTypes:false,removeAdditional:false}}});closers.push(()=>app.close());registerErrorHandlers(app)
  await app.register(fp(async app=>{app.decorate('authServices',f.auth)},{name:'business-auth'}))
  await app.register(profilePlugin,{profileServices:new ProfileService(f.db,'unused-community-contract-avatars','http://127.0.0.1:8080/api/avatars')})
  await app.register(fp(async app=>{app.decorate('identityLinkServices',f.links)},{name:'business-identity-links',dependencies:['business-auth']}))
  await app.register(communitiesPlugin,{communityServices:service});await app.register(authApi);await app.register(communitiesApi)
  const schemas={listCommunities:'CommunityList',getCommunity:'Community',listMyCommunityStatuses:'MyCommunityStatusList',getMyCommunityStatus:'MyCommunityStatus',getMyCommunityReviewAccess:'CommunityReviewAccess',createCommunity:'Community',updateCommunity:'Community',listCommunityReviewers:'CommunityReviewerList',grantCommunityReviewer:'CommunityReviewer',revokeCommunityReviewer:'RevokeCommunityReviewerResult'}
  const seen=new Set<string>()
  function capture<Id extends OperationId>(id:Id,schema:string,handler:TypedApiHandler<Id>):TypedApiHandler<Id>{return async(request,reply)=>{
    const result=await handler(request,reply);expect(compileComponentSchema(schema)(result),`raw ${id}`).toBe(true);seen.add(id);return result
  }}
  const handlers={
    listCommunities:capture('listCommunities',schemas.listCommunities,operations.listCommunities),getCommunity:capture('getCommunity',schemas.getCommunity,operations.getCommunity),
    listMyCommunityStatuses:capture('listMyCommunityStatuses',schemas.listMyCommunityStatuses,operations.listMyCommunityStatuses),getMyCommunityStatus:capture('getMyCommunityStatus',schemas.getMyCommunityStatus,operations.getMyCommunityStatus),
    getMyCommunityReviewAccess:capture('getMyCommunityReviewAccess',schemas.getMyCommunityReviewAccess,operations.getMyCommunityReviewAccess),createCommunity:capture('createCommunity',schemas.createCommunity,operations.createCommunity),
    updateCommunity:capture('updateCommunity',schemas.updateCommunity,operations.updateCommunity),listCommunityReviewers:capture('listCommunityReviewers',schemas.listCommunityReviewers,operations.listCommunityReviewers),
    grantCommunityReviewer:capture('grantCommunityReviewer',schemas.grantCommunityReviewer,operations.grantCommunityReviewer),revokeCommunityReviewer:capture('revokeCommunityReviewer',schemas.revokeCommunityReviewer,operations.revokeCommunityReviewer),
  }
  const document=readContract(),paths=Object.fromEntries(Object.entries(document.paths).filter(([,item])=>Object.values(item).some(op=>typeof op==='object'&&op!==null&&'operationId' in op&&typeof op.operationId==='string'&&op.operationId in handlers)))
  await app.register(glue,{specification:{...document,paths},prefix:'/api',serviceHandlers:handlers,securityHandlers:{bearerAuth:async(request:FastifyRequest)=>authenticateBearer(request,f.auth)}});await app.ready()
  const admin=await f.user('admin@example.com'),member=await f.user('member@example.com')
  await f.db.query("INSERT INTO community_group_memberships(user_id,group_code) VALUES ($1,'admin')",[admin.user.id])
  const auth={authorization:`Bearer ${admin.login.token}`},memberAuth={authorization:`Bearer ${member.login.token}`}
  async function call(method:'GET'|'POST'|'PUT'|'DELETE',url:string,headers:Record<string,string>={},payload?:object,status=200){
    const response=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});expect(response.statusCode,url).toBe(status);expect(response.headers['cache-control']).toBe('no-store');return response.json()
  }
  await call('GET','/api/communities');await call('GET','/api/communities/rifling-911')
  await call('GET','/api/auth/me/communities',memberAuth)
  expect(await call('GET','/api/auth/me/communities/rifling-911',memberAuth)).toMatchObject({missingProviders:['cfx'],websiteReady:false})
  expect(await call('GET','/api/auth/me/review-access',auth)).toMatchObject({isPlatformAdmin:true,communities:[]})
  await call('POST','/api/admin/communities',auth,{id:'second',displayName:'Second',requiresCfx:false},201)
  await call('PUT','/api/admin/communities/second',auth,{displayName:'Second updated',requiresCfx:true,expectedRevision:0})
  await call('GET','/api/admin/communities/second/reviewers',auth)
  await call('PUT',`/api/admin/communities/second/reviewers/${member.user.id}`,auth,{})
  expect(await call('GET','/api/auth/me/review-access',memberAuth)).toMatchObject({communities:[{id:'second'}]})
  await call('DELETE',`/api/admin/communities/second/reviewers/${member.user.id}`,auth)
  expect(await call('GET','/api/auth/me/review-access',memberAuth)).toMatchObject({communities:[]})
  expect(seen).toEqual(new Set(Object.keys(operations)))
  expect((await app.inject('/api/auth/me/review-access')).statusCode).toBe(401)
  expect((await app.inject({method:'POST',url:'/api/admin/communities',headers:memberAuth,payload:{id:'third',displayName:'Third',requiresCfx:false}})).statusCode).toBe(403)
  expect((await app.inject('/api/communities?limit=1&limit=2')).statusCode).toBe(400)
  expect((await app.inject('/api/communities?unknown=1')).statusCode).toBe(400)
})
