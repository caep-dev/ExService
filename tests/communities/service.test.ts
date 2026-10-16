import { afterEach, expect, it } from 'vitest'
import { isolatedPostgres } from '@tests/helpers/postgres'
import { AuthService } from '@server/src/modules/auth/service'
import { testPasswordHasher } from '@tests/helpers/auth'
import type { SqlExecutor } from '@server/src/db/client'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })
async function fixture() {
  const module = await import('@server/src/modules/communities/service').catch(() => undefined)
  expect(module, 'community service must implement scoped access').toBeDefined()
  const isolated = await isolatedPostgres()
  closers.push(isolated.close)
  const { db } = isolated
  const authServices = new AuthService({ db, passwordHasher: testPasswordHasher })
  const links = { async listInside(tx: SqlExecutor, userId: string) {
    return (await tx.query<{provider:string}>('SELECT provider FROM auth_identity_links WHERE user_id=$1', [userId])).rows
  } }
  const service = new module!.CommunityService({ db, authServices, identityLinkServices: links })
  async function user(id: string, admin = false) {
    await db.query('INSERT INTO auth_users (id,email,nickname,password_hash,created_at) VALUES ($1,$2,$3,$4,1)',
      [id, `${id}@example.com`, 'Member', await testPasswordHasher.hash('valid password')])
    if (admin) await db.query("INSERT INTO community_group_memberships(user_id,group_code) VALUES ($1,'admin')", [id])
    return authServices.authenticateToken((await authServices.login({email:`${id}@example.com`,password:'valid password'})).token)
  }
  return { db, authServices, service, user }
}
const adminId = '10000000-0000-4000-8000-000000000001'
const memberId = '10000000-0000-4000-8000-000000000002'

it('platform administration does not implicitly grant community review access', async () => {
  const f = await fixture(), admin = await f.user(adminId,true), member = await f.user(memberId)
  expect(await f.service.reviewAccess(admin)).toMatchObject({isPlatformAdmin:true,communities:[]})
  await expect(f.db.transaction(tx => f.service.assertReviewerInside(tx,admin,'rifling-911'))).rejects.toMatchObject({code:'COMMUNITY_REVIEW_FORBIDDEN'})
  await expect(f.service.create(member,{id:'second',displayName:'Second',requiresCfx:false})).rejects.toMatchObject({code:'COMMUNITY_REVIEW_FORBIDDEN'})
  await f.service.grantReviewer(admin,'rifling-911',member.userId)
  expect(await f.service.reviewAccess(member)).toMatchObject({isPlatformAdmin:false,communities:[{id:'rifling-911'}]})
  await f.service.revokeReviewer(admin,'rifling-911',member.userId)
  await expect(f.db.transaction(tx => f.service.assertReviewerInside(tx,member,'rifling-911'))).rejects.toMatchObject({code:'COMMUNITY_REVIEW_FORBIDDEN'})
})

it('community revision rejects stale configuration and ordinary users see only their own statuses', async () => {
  const f = await fixture(), admin = await f.user(adminId,true), member = await f.user(memberId)
  expect(await f.service.create(admin,{id:'second',displayName:'Second',requiresCfx:false})).toMatchObject({id:'second',configRevision:0})
  expect(await f.service.myStatus(member,'second')).toEqual({communityId:'second',application:null,membership:null,
    requiredProviders:[],missingProviders:[],requirementsMet:true,websiteReady:false})
  expect(await f.service.myStatus(member,'rifling-911')).toMatchObject({missingProviders:['cfx'],requirementsMet:false,websiteReady:false})
  expect(await f.service.listMyStatuses(member,{limit:20,offset:0})).toMatchObject({items:[],total:0})
  await f.service.update(admin,'second',{displayName:'New',requiresCfx:true,expectedRevision:0})
  await expect(f.service.update(admin,'second',{displayName:'Stale',requiresCfx:false,expectedRevision:0})).rejects.toMatchObject({code:'COMMUNITY_CONFIG_CONFLICT'})
  expect(await f.service.get('second')).toMatchObject({displayName:'New',requiresCfx:true,configRevision:1})
})

it('disabled reviewers and revoked sessions cannot read current permission hints or administer communities', async () => {
  const f = await fixture(), admin = await f.user(adminId,true), member = await f.user(memberId)
  await f.service.grantReviewer(admin,'rifling-911',member.userId)
  await f.authServices.disableUser(member.userId)
  await expect(f.service.reviewAccess(member)).rejects.toMatchObject({code:'SESSION_INVALID'})
  await f.authServices.logout(admin)
  await expect(f.service.create(admin,{id:'second',displayName:'Second',requiresCfx:false})).rejects.toMatchObject({code:'SESSION_INVALID'})
})

it('an in-flight authorized decision serializes with reviewer revocation on the real database locks', async () => {
  const f = await fixture(), admin = await f.user(adminId,true), member = await f.user(memberId)
  await f.service.grantReviewer(admin,'rifling-911',member.userId)
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release=resolve })
  const ready = new Promise<void>(resolve => { entered=resolve })
  const decision = f.db.transaction(async tx => { await f.service.assertReviewerInside(tx,member,'rifling-911');entered();await barrier })
  await ready
  const revoke = f.service.revokeReviewer(admin,'rifling-911',member.userId)
  try {
    let waiting=false
    for(let attempt=0;attempt<100&&!waiting;attempt++) {
      const row=(await f.db.query<{n:number}>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM auth_users%'")).rows[0]!
      waiting=row.n>0
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,10))
    }
    expect(waiting,'revocation must wait for the admitted decision account lock').toBe(true)
  } finally {release();await decision;await revoke}
  await expect(f.db.transaction(tx=>f.service.assertReviewerInside(tx,member,'rifling-911'))).rejects.toMatchObject({code:'COMMUNITY_REVIEW_FORBIDDEN'})
})

it('grant is idempotent, requires an enabled target and never grants access to a different community', async () => {
  const f=await fixture(),admin=await f.user(adminId,true),member=await f.user(memberId)
  await f.service.create(admin,{id:'second',displayName:'Second',requiresCfx:false})
  const first=await f.service.grantReviewer(admin,'rifling-911',member.userId)
  expect(await f.service.grantReviewer(admin,'rifling-911',member.userId)).toEqual(first)
  await expect(f.db.transaction(tx=>f.service.assertReviewerInside(tx,member,'second'))).rejects.toMatchObject({code:'COMMUNITY_REVIEW_FORBIDDEN'})
  await f.authServices.disableUser(member.userId)
  await expect(f.service.grantReviewer(admin,'second',member.userId)).rejects.toMatchObject({code:'COMMUNITY_NOT_FOUND'})
})
