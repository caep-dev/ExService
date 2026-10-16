import type { components } from '@workspace/api-client/types'
import type { AppDatabase, SqlExecutor } from '../../db/client.js'
import { AuthError } from '../auth/errors.js'
import type { AuthService, SessionIdentity } from '../auth/service.js'
import type { CfxBrowserContext, CfxCancellation, CfxIdentity, CfxServices } from '../cfx/types.js'
import { ExternalAccountService } from '../external-accounts/service.js'
import { IdentityLinkError } from './errors.js'

export type IdentityLink = components['schemas']['IdentityLink']
interface LinkRow {
  id: string
  user_id: string
  provider: 'cfx'
  external_user_id: string
  external_username: string
  provider_email: string | null
  linked_at: number
}
interface Intent {
  userId: string
  sessionId: string
  expiresAt: number
  invalid: boolean
  consuming: boolean
  attemptId?: string
  context?: CfxBrowserContext
}
export interface IdentityLinkServiceDependencies {
  db: AppDatabase
  auth: AuthService
  cfx: CfxServices
  externalAccounts?: ExternalAccountService
  now?: () => number
}
export class IdentityLinkService {
  private readonly now: () => number
  private readonly intents = new Set<Intent>()
  private readonly work = new Set<Promise<unknown>>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private closing?: Promise<void>
  readonly externalAccounts: ExternalAccountService
  constructor(private readonly d: IdentityLinkServiceDependencies) {
    this.now = d.now ?? Date.now
    this.externalAccounts = d.externalAccounts ?? new ExternalAccountService(d)
  }
  async start() {
    if (!this.closed && !this.timer) {
      this.timer = setInterval(() => this.prune(), 1000)
      this.timer.unref()
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    clearInterval(this.timer)
    for (const intent of this.intents) intent.invalid = true
    this.closing = Promise.allSettled([...this.work]).then(() => {
      this.intents.clear()
    })
    return this.closing
  }
  async findBySubjectInside(tx: SqlExecutor, provider: 'cfx', subject: string) {
    return this.externalAccounts.findBySubjectInside(tx, provider, subject)
  }
  async listInside(tx: SqlExecutor, userId: string): Promise<IdentityLink[]> {
    return (
      await tx.query<LinkRow>('SELECT * FROM auth_identity_links WHERE user_id=$1 ORDER BY provider', [
        userId,
      ])
    ).rows.map(project)
  }
  async createInside(
    tx: SqlExecutor,
    identity: Pick<CfxIdentity, 'id' | 'username' | 'email'>,
    userId: string,
  ): Promise<IdentityLink> {
    return this.externalAccounts.createSeedLinkInside(tx, identity, userId)
  }
  async list(session: SessionIdentity): Promise<components['schemas']['IdentityLinksResponse']> {
    return this.track(async () =>
      this.d.db.transaction(async (tx) => {
        await this.lockOwner(tx, session)
        const links = await this.listInside(tx, session.userId)
        const byProvider = new Map(links.map((link) => [link.provider, link]))
        return {
          providers: [
            { provider: 'cfx', available: this.d.cfx.config.enabled, link: byProvider.get('cfx') ?? null },
            { provider: 'google', available: false, link: null },
            { provider: 'qq', available: false, link: null },
          ],
        }
      }),
    )
  }
  begin(session: SessionIdentity, input: { bindingToken?: string; clientIp: string; signal?: AbortSignal }) {
    return this.track(async () => {
      this.prune()
      if (
        this.intents.size >= 256 ||
        [...this.intents].filter((i) => i.userId === session.userId).length >= 3
      )
        throw new IdentityLinkError('REGISTRATION_CAPACITY_EXCEEDED')
      const intent: Intent = {
        userId: session.userId,
        sessionId: session.id,
        expiresAt: this.now() + 600_000,
        invalid: false,
        consuming: false,
      }
      this.intents.add(intent)
      try {
        await this.d.db.transaction((tx) => this.lockOwner(tx, session))
        this.assertIntent(intent)
        const result = await this.d.cfx.begin(input)
        const context = this.d.cfx.resolveBrowserContext({
          bindingToken: result.cookieValue,
          clientIp: input.clientIp,
        })
        intent.attemptId = result.response.attemptId
        intent.context = context
        if (this.closed || intent.invalid || this.now() >= intent.expiresAt) {
          try {
            this.d.cfx.cancel(context, intent.attemptId)
          } catch {
            /* Cfx owns expiry. */
          }
          throw new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID')
        }
        return result
      } catch (error) {
        this.intents.delete(intent)
        throw error
      }
    })
  }
  link(
    session: SessionIdentity,
    context: CfxBrowserContext,
    attemptId: string,
    identityTicket: string,
  ): Promise<IdentityLink> {
    return this.track(async () => {
      const intent = [...this.intents].find((i) => i.attemptId === attemptId)
      if (!intent) throw new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID')
      if (intent.consuming) throw new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID')
      try {
        this.assertIntent(intent)
        if (
          intent.consuming ||
          intent.userId !== session.userId ||
          intent.sessionId !== session.id ||
          intent.context?.bindingDigest !== context.bindingDigest
        )
          throw new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID')
        intent.consuming = true
        const identity = this.externalAccounts.consumeCfx(context, identityTicket, intent.attemptId)
        return await this.d.db.transaction(async (tx) => {
          await this.lockOwner(tx, session)
          this.assertIntent(intent)
          return this.externalAccounts.createLinkInside(tx, identity, session.userId)
        })
      } finally {
        intent.invalid = true
        this.intents.delete(intent)
      }
    })
  }
  unlink(session: SessionIdentity): Promise<{ status: 'unlinked' }> {
    return this.track(() =>
      this.d.db.transaction(async (tx) => {
        await this.lockOwner(tx, session)
        for (const intent of this.intents) if (intent.userId === session.userId) intent.invalid = true
        await tx.query('DELETE FROM auth_identity_links WHERE user_id=$1 AND provider=$2', [
          session.userId,
          'cfx',
        ])
        return { status: 'unlinked' as const }
      }),
    )
  }
  invalidateCfxAttempt(context: CfxBrowserContext, attemptId: string): void {
    for (const intent of this.intents) {
      if (intent.attemptId !== attemptId || intent.context?.bindingDigest !== context.bindingDigest) continue
      intent.invalid = true
      // In-flight consumption owns its reservation until the transaction settles.
      if (!intent.consuming) this.intents.delete(intent)
    }
  }
  cancelCfxAttempt(context: CfxBrowserContext, attemptId: string): CfxCancellation {
    const result = this.d.cfx.cancel(context, attemptId)
    if (result.state === 'cancelled' || result.state === 'failed' || result.state === 'expired')
      this.invalidateCfxAttempt(context, result.attemptId)
    return result
  }
  private async lockOwner(tx: SqlExecutor, session: SessionIdentity) {
    const row = (
      await tx.query<{ disabled_at: number | null }>(
        'SELECT disabled_at FROM auth_users WHERE id=$1 FOR NO KEY UPDATE',
        [session.userId],
      )
    ).rows[0]
    if (!row || row.disabled_at !== null) throw new AuthError('SESSION_INVALID')
    await this.d.auth.assertSessionCurrent(session, tx, true)
  }
  private assertIntent(intent: Intent) {
    if (this.closed || intent.invalid || this.now() >= intent.expiresAt)
      throw new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID')
  }
  private prune() {
    for (const intent of this.intents)
      if (!intent.consuming && intent.attemptId && (intent.invalid || this.now() >= intent.expiresAt))
        this.intents.delete(intent)
  }
  private track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new IdentityLinkError('IDENTITY_LINK_ATTEMPT_INVALID'))
    const work = fn()
    this.work.add(work)
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    )
    return work
  }
}
function project(row: LinkRow): IdentityLink {
  if (row.provider !== 'cfx') throw new Error('Unexpected identity provider')
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
