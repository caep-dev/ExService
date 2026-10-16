import type { components } from '@workspace/api-client/types'
import type { AppDatabase, SqlExecutor } from '../../db/client.js'
import type { AuthService, SessionIdentity } from '../auth/service.js'
import { AuthError } from '../auth/errors.js'
import { CommunityError } from './errors.js'

type Community = components['schemas']['Community']
type Status = components['schemas']['MyCommunityStatus']
type Reviewer = components['schemas']['CommunityReviewer']
interface CommunityRow { id: string; display_name: string; requires_cfx: boolean; config_revision: number }
interface ReviewerRow { user_id: string; nickname: string; granted_by_user_id: string; granted_at: number }
interface Page { limit: number; offset: number }
export interface CommunityIdentityLinks { listInside(tx: SqlExecutor, userId: string): Promise<ReadonlyArray<{ provider: string }>> }
export interface CommunityDependencies {
  db: AppDatabase; authServices: AuthService; identityLinkServices: CommunityIdentityLinks; now?: () => number
}
const community = (row: CommunityRow): Community => ({ id: row.id, displayName: row.display_name, requiresCfx: row.requires_cfx, configRevision: row.config_revision })
const reviewer = (row: ReviewerRow): Reviewer => ({ userId: row.user_id, nickname: row.nickname, grantedByUserId: row.granted_by_user_id, grantedAt: row.granted_at })
function validatePage(page: Page): void {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 50 || !Number.isSafeInteger(page.offset) || page.offset < 0) throw new AuthError('BAD_REQUEST')
}
function validateConfig(input: { displayName: string; requiresCfx: boolean }): void {
  const length = Array.from(input.displayName.trim()).length
  if (length < 1 || length > 80 || /[\u0000-\u001f\u007f]/.test(input.displayName) || typeof input.requiresCfx !== 'boolean') throw new AuthError('BAD_REQUEST')
}

export class CommunityService {
  private readonly now: () => number
  constructor(private readonly deps: CommunityDependencies) { this.now = deps.now ?? Date.now }

  async lockAccountsInside(tx: SqlExecutor, ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) {
      const found = await tx.query('SELECT id FROM auth_users WHERE id=$1 FOR NO KEY UPDATE', [id])
      if (found.rowCount !== 1) throw new CommunityError('COMMUNITY_NOT_FOUND')
    }
  }
  private async currentInside(tx: SqlExecutor, session: SessionIdentity): Promise<void> {
    await this.lockAccountsInside(tx, [session.userId])
    await this.deps.authServices.assertSessionCurrent(session, tx, true)
  }
  async getCommunityInside(tx: SqlExecutor, id: string, lock: 'share' | 'write' | 'none' = 'none'): Promise<Community> {
    const row = (await tx.query<CommunityRow>(`SELECT id,display_name,requires_cfx,config_revision FROM communities WHERE id=$1${lock === 'share' ? ' FOR SHARE' : lock === 'write' ? ' FOR NO KEY UPDATE' : ''}`, [id])).rows[0]
    if (!row) throw new CommunityError('COMMUNITY_NOT_FOUND')
    return community(row)
  }
  async assertPlatformAdminInside(tx: SqlExecutor, session: SessionIdentity, locksManaged = false): Promise<void> {
    if (!locksManaged) await this.currentInside(tx, session)
    const result = await tx.query("SELECT user_id FROM community_group_memberships WHERE user_id=$1 AND group_code='admin' FOR SHARE", [session.userId])
    if (result.rowCount !== 1) throw new CommunityError('COMMUNITY_REVIEW_FORBIDDEN')
  }
  async assertReviewerInside(tx: SqlExecutor, session: SessionIdentity, communityId: string, locksManaged = false): Promise<Community> {
    if (!locksManaged) await this.currentInside(tx, session)
    const config = await this.getCommunityInside(tx, communityId, 'share')
    const result = await tx.query('SELECT user_id FROM community_reviewers WHERE community_id=$1 AND user_id=$2 FOR SHARE', [communityId, session.userId])
    if (result.rowCount !== 1) throw new CommunityError('COMMUNITY_REVIEW_FORBIDDEN')
    return config
  }
  async assertReviewerReadInside(tx: SqlExecutor, session: SessionIdentity, communityId: string): Promise<Community> {
    await this.deps.authServices.assertSessionCurrent(session, tx)
    const config = await this.getCommunityInside(tx, communityId)
    const result = await tx.query('SELECT 1 FROM community_reviewers WHERE community_id=$1 AND user_id=$2', [communityId,session.userId])
    if (result.rowCount !== 1) throw new CommunityError('COMMUNITY_REVIEW_FORBIDDEN')
    return config
  }
  async requirementsInside(tx: SqlExecutor, communityId: string, userId: string) {
    const config = await this.getCommunityInside(tx, communityId)
    const links = await this.deps.identityLinkServices.listInside(tx,userId)
    const requiredProviders: Array<'cfx'> = config.requiresCfx ? ['cfx'] : []
    const missingProviders = requiredProviders.filter(provider => !links.some(link => link.provider === provider))
    return { requiredProviders, missingProviders, requirementsMet: missingProviders.length === 0 }
  }
  async insertMembershipInside(tx: SqlExecutor, input: { userId: string; communityId: string; applicationId: string; joinedAt: number }): Promise<void> {
    const result = await tx.query(`INSERT INTO community_memberships(user_id,community_id,application_id,joined_at)
      SELECT user_id,community_id,id,$4 FROM join_applications WHERE id=$3 AND user_id=$1 AND community_id=$2 AND status='approved'`,
    [input.userId,input.communityId,input.applicationId,input.joinedAt])
    if (result.rowCount !== 1) throw new Error('Invalid approved application membership.')
  }
  async get(id: string): Promise<Community> { return this.getCommunityInside(this.deps.db,id) }
  async list(page: Page = {limit:20,offset:0}) {
    validatePage(page)
    return this.deps.db.transaction(async tx => {
      const rows = await tx.query<CommunityRow>('SELECT id,display_name,requires_cfx,config_revision FROM communities ORDER BY id LIMIT $1 OFFSET $2',[page.limit,page.offset])
      const total = Number((await tx.query<{n:number}>('SELECT count(*) AS n FROM communities')).rows[0]!.n)
      return {items:rows.rows.map(community),...page,total}
    },'repeatable-read-read-only')
  }
  private async statusInside(tx: SqlExecutor, session: SessionIdentity, communityId: string): Promise<Status> {
    const requirements = await this.requirementsInside(tx,communityId,session.userId)
    const application = (await tx.query<{id:string;status:'pending'|'approved'|'rejected';created_at:number;reviewed_at:number|null}>(
      'SELECT id,status,created_at,reviewed_at FROM join_applications WHERE user_id=$1 AND community_id=$2',[session.userId,communityId])).rows[0]
    const membership = (await tx.query<{application_id:string;joined_at:number}>(
      'SELECT application_id,joined_at FROM community_memberships WHERE user_id=$1 AND community_id=$2',[session.userId,communityId])).rows[0]
    return {communityId, application:application ? {id:application.id,status:application.status,createdAt:application.created_at,reviewedAt:application.reviewed_at} : null,
      membership:membership ? {applicationId:membership.application_id,joinedAt:membership.joined_at} : null,
      ...requirements,websiteReady:membership !== undefined && requirements.requirementsMet}
  }
  async myStatus(session: SessionIdentity,id: string): Promise<Status> {
    return this.deps.db.transaction(async tx => { await this.deps.authServices.assertSessionCurrent(session,tx); return this.statusInside(tx,session,id) },'repeatable-read-read-only')
  }
  async listMyStatuses(session:SessionIdentity,page:Page = {limit:20,offset:0}) {
    validatePage(page)
    return this.deps.db.transaction(async tx => {
      await this.deps.authServices.assertSessionCurrent(session,tx)
      const predicate = `EXISTS(SELECT 1 FROM join_applications a WHERE a.community_id=c.id AND a.user_id=$1)
        OR EXISTS(SELECT 1 FROM community_memberships m WHERE m.community_id=c.id AND m.user_id=$1)`
      const rows = await tx.query<{id:string}>(`SELECT c.id FROM communities c WHERE ${predicate} ORDER BY c.id LIMIT $2 OFFSET $3`,[session.userId,page.limit,page.offset])
      const total = Number((await tx.query<{n:number}>(`SELECT count(*) AS n FROM communities c WHERE ${predicate}`,[session.userId])).rows[0]!.n)
      const items:Status[]=[]
      for(const row of rows.rows)items.push(await this.statusInside(tx,session,row.id))
      return {items,...page,total}
    },'repeatable-read-read-only')
  }
  async reviewAccess(session:SessionIdentity) {
    return this.deps.db.transaction(async tx => {
      await this.deps.authServices.assertSessionCurrent(session,tx)
      const admin = await tx.query("SELECT 1 FROM community_group_memberships WHERE user_id=$1 AND group_code='admin'",[session.userId])
      const rows = await tx.query<CommunityRow>('SELECT c.id,c.display_name,c.requires_cfx,c.config_revision FROM communities c JOIN community_reviewers r ON r.community_id=c.id WHERE r.user_id=$1 ORDER BY c.id',[session.userId])
      return {isPlatformAdmin:admin.rowCount===1,communities:rows.rows.map(community)}
    },'repeatable-read-read-only')
  }
  async create(session:SessionIdentity,input:components['schemas']['CreateCommunityRequest']):Promise<Community> {
    validateConfig(input)
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)||input.id.length>64)throw new AuthError('BAD_REQUEST')
    try {
      return await this.deps.db.transaction(async tx => {
        await this.assertPlatformAdminInside(tx,session)
        const now=this.now()
        await tx.query('INSERT INTO communities(id,display_name,requires_cfx,config_revision,created_at,updated_at) VALUES ($1,$2,$3,0,$4,$4)',[input.id,input.displayName.trim(),input.requiresCfx,now])
        return this.getCommunityInside(tx,input.id)
      })
    } catch(error) { if((error as {code?:string}).code==='23505')throw new CommunityError('COMMUNITY_CONFIG_CONFLICT');throw error }
  }
  async update(session:SessionIdentity,id:string,input:components['schemas']['UpdateCommunityRequest']):Promise<Community> {
    validateConfig(input)
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new AuthError('BAD_REQUEST')
    return this.deps.db.transaction(async tx => {
      await this.currentInside(tx,session)
      const current=await this.getCommunityInside(tx,id,'write')
      await this.assertPlatformAdminInside(tx,session,true)
      if(current.configRevision!==input.expectedRevision || current.configRevision===Number.MAX_SAFE_INTEGER)throw new CommunityError('COMMUNITY_CONFIG_CONFLICT')
      await tx.query('UPDATE communities SET display_name=$2,requires_cfx=$3,config_revision=config_revision+1,updated_at=$4 WHERE id=$1',[id,input.displayName.trim(),input.requiresCfx,this.now()])
      return this.getCommunityInside(tx,id)
    })
  }
  async listReviewers(session:SessionIdentity,id:string,page:Page={limit:20,offset:0}) {
    validatePage(page)
    return this.deps.db.transaction(async tx => {
      await this.deps.authServices.assertSessionCurrent(session,tx)
      await this.getCommunityInside(tx,id)
      if((await tx.query("SELECT 1 FROM community_group_memberships WHERE user_id=$1 AND group_code='admin'",[session.userId])).rowCount!==1)throw new CommunityError('COMMUNITY_REVIEW_FORBIDDEN')
      const rows=await tx.query<ReviewerRow>('SELECT r.user_id,u.nickname,r.granted_by_user_id,r.granted_at FROM community_reviewers r JOIN auth_users u ON u.id=r.user_id WHERE r.community_id=$1 ORDER BY r.user_id LIMIT $2 OFFSET $3',[id,page.limit,page.offset])
      const total=Number((await tx.query<{n:number}>('SELECT count(*) AS n FROM community_reviewers WHERE community_id=$1',[id])).rows[0]!.n)
      return {items:rows.rows.map(reviewer),...page,total}
    },'repeatable-read-read-only')
  }
  async grantReviewer(session:SessionIdentity,id:string,userId:string):Promise<Reviewer> {
    return this.deps.db.transaction(async tx => {
      await this.lockAccountsInside(tx,[session.userId,userId])
      await this.deps.authServices.assertSessionCurrent(session,tx,true)
      await this.getCommunityInside(tx,id,'write')
      await this.assertPlatformAdminInside(tx,session,true)
      const target=(await tx.query<{disabled_at:number|null}>('SELECT disabled_at FROM auth_users WHERE id=$1',[userId])).rows[0]!
      if(target.disabled_at!==null)throw new CommunityError('COMMUNITY_NOT_FOUND')
      await tx.query('INSERT INTO community_reviewers(community_id,user_id,granted_by_user_id,granted_at) VALUES ($1,$2,$3,$4) ON CONFLICT(community_id,user_id) DO NOTHING',[id,userId,session.userId,this.now()])
      const row=(await tx.query<ReviewerRow>('SELECT r.user_id,u.nickname,r.granted_by_user_id,r.granted_at FROM community_reviewers r JOIN auth_users u ON u.id=r.user_id WHERE r.community_id=$1 AND r.user_id=$2',[id,userId])).rows[0]!
      return reviewer(row)
    })
  }
  async revokeReviewer(session:SessionIdentity,id:string,userId:string) {
    return this.deps.db.transaction(async tx => {
      await this.lockAccountsInside(tx,[session.userId,userId])
      await this.deps.authServices.assertSessionCurrent(session,tx,true)
      await this.getCommunityInside(tx,id,'write')
      await this.assertPlatformAdminInside(tx,session,true)
      await tx.query('DELETE FROM community_reviewers WHERE community_id=$1 AND user_id=$2',[id,userId])
      return {status:'revoked' as const}
    })
  }
}
