import { randomUUID } from 'node:crypto'
import type { components } from '@workspace/api-client/types'
import type { AppDatabase, SqlExecutor } from '../../db/client.js'
import { AuthError } from '../auth/errors.js'
import type { AuthService } from '../auth/service.js'
import type { CfxBrowserContext, CfxIdentity, CfxServices } from '../cfx/types.js'
import { IdentityLinkError } from '../identity-links/errors.js'
import { consumeCfxIdentity, assertVerifiedExternalIdentity, type VerifiedExternalIdentity } from './cfx-adapter.js'

type IdentityLink = components['schemas']['IdentityLink']
interface LinkRow {
  id: string
  user_id: string
  provider: 'cfx'
  external_user_id: string
  external_username: string
  provider_email: string | null
  linked_at: number
}
export interface LockedExternalGrantSnapshot {
  kind: 'email' | 'cfx'
  external_user_id: string | null
  external_username: string | null
  provider_email: string | null
}
export interface ExternalAccountDependencies {
  db: AppDatabase
  auth: AuthService
  cfx: CfxServices
  now?: () => number
}

/** Account policy after a provider ticket has been consumed, independent of HTTP handlers. */
export class ExternalAccountService {
  private readonly now: () => number
  constructor(private readonly d: ExternalAccountDependencies) {
    this.now = d.now ?? Date.now
  }

  consumeCfx(context: CfxBrowserContext, ticket: string, expectedAttemptId?: string): VerifiedExternalIdentity {
    return consumeCfxIdentity(this.d.cfx, context, ticket, expectedAttemptId)
  }

  async findBySubjectInside(tx: SqlExecutor, provider: 'cfx', subject: string) {
    const row = (
      await tx.query<LinkRow>('SELECT * FROM auth_identity_links WHERE provider=$1 AND external_user_id=$2', [
        provider, subject,
      ])
    ).rows[0]
    return row ? { ...project(row), userId: row.user_id } : undefined
  }

  async signInVerified(
    proof: VerifiedExternalIdentity,
    bindingHash: string,
    issueGrantInside: (tx: SqlExecutor, email: string, bindingHash: string, identity: Pick<CfxIdentity, 'id' | 'username' | 'email'>) => Promise<{
      registrationToken: string
      email: string
      expiresAt: number
    }>,
  ): Promise<components['schemas']['CfxSignInResult']> {
    assertVerifiedExternalIdentity(proof)
    const candidate = await this.findBySubjectInside(this.d.db, proof.provider, proof.subject)
    if (candidate)
      return this.d.db.transaction(async (tx) => {
        const user = (
          await tx.query<{ disabled_at: number | null }>(
            'SELECT disabled_at FROM auth_users WHERE id=$1 FOR NO KEY UPDATE',
            [candidate.userId],
          )
        ).rows[0]
        if (!user || user.disabled_at !== null) throw new AuthError('SESSION_INVALID')
        const row = (
          await tx.query<{ id: string; external_user_id: string }>(
            'SELECT id,external_user_id FROM auth_identity_links WHERE user_id=$1 AND provider=$2 FOR UPDATE',
            [candidate.userId, proof.provider],
          )
        ).rows[0]
        if (!row || row.id !== candidate.id || row.external_user_id !== proof.subject)
          throw new IdentityLinkError('IDENTITY_LINK_CONFLICT')
        return { kind: 'signed-in' as const, ...(await this.d.auth.createSessionInside(tx, candidate.userId)) }
      })
    return this.d.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(163826, 1)')
      if (await this.findBySubjectInside(tx, proof.provider, proof.subject))
        throw new IdentityLinkError('IDENTITY_LINK_CONFLICT')
      if ((await tx.query('SELECT id FROM auth_users WHERE email=$1', [proof.providerEmail])).rows.length)
        return { kind: 'account-exists' as const, email: proof.providerEmail, nextAction: 'login_then_link' as const }
      const grant = await issueGrantInside(tx, proof.providerEmail, bindingHash, {
        id: proof.subject,
        username: proof.username,
        email: proof.providerEmail,
      })
      return {
        kind: 'registration-required' as const,
        ...grant,
        suggestedNickname: !/[\u0000-\u001f\u007f-\u009f]/u.test(proof.username)
          ? [...proof.username.trim()].slice(0, 32).join('') || null
          : null,
      }
    })
  }

  createLinkInside(tx: SqlExecutor, proof: VerifiedExternalIdentity, userId: string): Promise<IdentityLink> {
    assertVerifiedExternalIdentity(proof)
    return this.insertLinkInside(tx, userId, proof.provider, proof.subject, proof.username, proof.providerEmail)
  }

  createLinkFromGrantInside(tx: SqlExecutor, grant: LockedExternalGrantSnapshot, userId: string): Promise<IdentityLink> {
    if (grant.kind !== 'cfx' || !grant.external_user_id || !grant.external_username || !grant.provider_email)
      throw new Error('Invalid persisted external identity snapshot')
    return this.insertLinkInside(tx, userId, 'cfx', grant.external_user_id, grant.external_username, grant.provider_email)
  }

  /** Existing internal fixture and seed seam; HTTP requests never call this. */
  createSeedLinkInside(tx: SqlExecutor, identity: Pick<CfxIdentity, 'id' | 'username' | 'email'>, userId: string): Promise<IdentityLink> {
    return this.insertLinkInside(tx, userId, 'cfx', identity.id, identity.username, identity.email)
  }

  private async insertLinkInside(
    tx: SqlExecutor,
    userId: string,
    provider: 'cfx',
    subject: string,
    username: string,
    providerEmail: string,
  ): Promise<IdentityLink> {
    const id = randomUUID(), linkedAt = this.now()
    try {
      await tx.query(
        `INSERT INTO auth_identity_links (id,user_id,provider,external_user_id,external_username,provider_email,linked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, userId, provider, subject, username, providerEmail, linkedAt],
      )
    } catch (error) {
      if (uniqueViolation(error)) throw new IdentityLinkError('IDENTITY_LINK_CONFLICT')
      throw error
    }
    return { id, provider, externalUserId: subject, externalUsername: username, providerEmail, linkedAt }
  }
}

function project(row: LinkRow): IdentityLink {
  if (row.provider_email === null) throw new Error('Identity link email missing')
  return {
    id: row.id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    externalUsername: row.external_username,
    providerEmail: row.provider_email,
    linkedAt: row.linked_at,
  }
}

export function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
