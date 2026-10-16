import type { FastifyPluginAsync,onRequestHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { operations } from './operations.js'
const plugin:FastifyPluginAsync = async app => {
  app.getDecorator('communityServices')
  app.addHook('onRoute',route => {
    const operationId=(route.schema as {operationId?:string}|undefined)?.operationId
    if(!operationId||!Object.hasOwn(operations,operationId))return
    if(route.method==='POST'||route.method==='PUT')route.bodyLimit=4096
    const guard:onRequestHookHandler=async(request,reply)=>{
      reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff')
      if((request.method==='GET'||request.method==='HEAD'||request.method==='DELETE')&&
        (Number(request.headers['content-length']??0)>0||request.headers['transfer-encoding']))throw Object.assign(new Error('Unexpected body.'),{statusCode:400})
      if((request.method==='POST'||request.method==='PUT')&&!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??''))throw Object.assign(new Error('JSON required.'),{statusCode:415})
      const raw=(request.raw.url??'').split('?')[1]??''
      if(/%(?![0-9a-f]{2})/i.test(raw))throw Object.assign(new Error('Invalid query.'),{statusCode:400})
      const allowed=operationId==='listCommunities'||operationId==='listMyCommunityStatuses'||operationId==='listCommunityReviewers'?new Set(['limit','offset']):new Set<string>()
      const seen=new Set<string>()
      for(const key of new URLSearchParams(raw).keys()) {
        if(!allowed.has(key)||seen.has(key))throw Object.assign(new Error('Invalid query.'),{statusCode:400})
        seen.add(key)
      }
    }
    route.onRequest=[guard,...(route.onRequest===undefined?[]:Array.isArray(route.onRequest)?route.onRequest:[route.onRequest])]
  })
}
export default fp(plugin,{name:'api-communities',fastify:'5.x',dependencies:['business-communities','api-auth'],decorators:{fastify:['communityServices'],request:['authSession']}})
