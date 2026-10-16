import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { components } from '@workspace/api-client/types'
import type { AppDatabase, SqlExecutor } from '../../db/client.js'
import { AuthError } from '../auth/errors.js'
import type { PasswordHasher } from '../auth/crypto.js'
import type { AuthService } from '../auth/service.js'
import type { CfxBrowserContext, CfxIdentity, CfxServices } from '../cfx/types.js'
import type { IdentityLinkService } from '../identity-links/service.js'
import { ExternalAccountService, uniqueViolation } from '../external-accounts/service.js'
import { RegistrationError } from './errors.js'

export interface RegistrationMailer {
  send(input: {
    recipient: string
    code: string
    codeExpiresAt: number
    attemptId: string
    signal: AbortSignal
  }): Promise<void>
}
export interface RegistrationServiceDependencies {
  db: AppDatabase
  auth: AuthService
  identityLinks: IdentityLinkService
  externalAccounts?: ExternalAccountService
  /** Retained for direct service consumers; ticket consumption is owned by externalAccounts. */
  cfx?: CfxServices
  passwordHasher: PasswordHasher
  codeHmacKey: Buffer
  mailer?: RegistrationMailer
  now?: () => number
}
interface EmailRow {
  id: string
  email: string
  code_version: number
  code_hmac: string | null
  code_expires_at: number | null
  code_browser_binding_hash: string | null
  next_send_at: number
  failed_attempts: number
  failure_window_started_at: number | null
}
interface GrantRow {
  id: string
  token_hash: string
  browser_binding_hash: string
  kind: 'email' | 'cfx'
  email: string
  external_user_id: string | null
  external_username: string | null
  provider_email: string | null
  state: 'active' | 'processing' | 'completed' | 'failed'
  expires_at: number
  completed_at: number | null
  completed_user_id: string | null
}
type Result = components['schemas']['RegistrationResult']
const WINDOW = 600_000,
  REPLAY = 300_000
export class RegistrationService {
  private readonly now: () => number
  private readonly work = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private readonly activeDeliveries = new Set<string>()
  private readonly activeGrants = new Set<string>()
  private readonly ips = new Map<string, { count: number; expiresAt: number }>()
  private mailSlots = 0
  private closed = false
  private closing?: Promise<void>
  private starting?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private cleaning = false
  private readonly externalAccounts: ExternalAccountService
  constructor(private readonly d: RegistrationServiceDependencies) {
    this.now = d.now ?? Date.now
    this.externalAccounts = d.externalAccounts ?? d.identityLinks.externalAccounts
    if (d.codeHmacKey.length !== 32) throw new Error('Invalid registration HMAC key')
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return (this.starting ??= this.d.db
      .query(
        `UPDATE auth_registration_deliveries SET status='failed',finished_at=$1 WHERE status='pending'`,
        [this.now()],
      )
      .then(() => {
        if (!this.closed) {
          this.timer = setInterval(() => {
            if (!this.cleaning) {
              this.cleaning = true
              void this.track(() => this.cleanup())
                .catch(() => {})
                .finally(() => {
                  this.cleaning = false
                })
            }
          }, 1000)
          this.timer.unref()
        }
      }))
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort()
    this.closing = (async () => {
      await this.starting
      while (this.work.size) await Promise.allSettled([...this.work])
      this.ips.clear()
    })()
    return this.closing
  }
  limitIp(ip: string) {
    this.assertOpen()
    const now = this.now()
    for (const [key, value] of this.ips) if (value.expiresAt <= now) this.ips.delete(key)
    let row = this.ips.get(ip)
    if (!row) {
      if (this.ips.size >= 1024) throw new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED')
      row = { count: 0, expiresAt: now + 60_000 }
      this.ips.set(ip, row)
    }
    if (row.count >= 60)
      throw new AuthError('JOIN_RATE_LIMITED', { retryAfterSeconds: seconds(row.expiresAt - now) })
    row.count++
  }
  requestCode(
    emailInput: string,
    bindingHash: string,
  ): Promise<components['schemas']['RegistrationCodeRequested']> {
    return this.track(async () => {
      if (!this.d.mailer) throw new RegistrationError('REGISTRATION_MAIL_UNAVAILABLE')
      if (this.mailSlots >= 4) throw new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED')
      this.mailSlots++
      let reserved = false
      try {
        const email = emailInput.trim().toLowerCase(),
          code = randomInt(0, 1_000_000).toString().padStart(6, '0')
        const delivery = await this.d.db.transaction(async (tx) => {
          await capacityLock(tx)
          if ((await tx.query('SELECT id FROM auth_users WHERE email=$1', [email])).rows.length)
            throw new AuthError('EMAIL_IN_USE')
          let row = (
            await tx.query<EmailRow>('SELECT * FROM auth_registration_emails WHERE email=$1 FOR UPDATE', [
              email,
            ])
          ).rows[0]
          const now = this.now()
          if (row) {
            this.assertUnlocked(row, now)
            if (row.next_send_at > now)
              throw new RegistrationError(
                'REGISTRATION_CODE_RESEND_TOO_SOON',
                seconds(row.next_send_at - now),
              )
          }
          await this.assertCount(tx, 'auth_registration_deliveries', 4096)
          if (!row) {
            await this.assertCount(tx, 'auth_registration_emails', 1024)
            row = (
              await tx.query<EmailRow>(
                `INSERT INTO auth_registration_emails(id,email,next_send_at,updated_at) VALUES($1,$2,$3,$3) RETURNING *`,
                [randomUUID(), email, now],
              )
            ).rows[0]!
          }
          const version = row.code_version + 1,
            expiresAt = now + WINDOW,
            attemptId = randomUUID()
          const reset =
            row.failure_window_started_at === null || row.failure_window_started_at + WINDOW <= now
          await tx.query(
            `UPDATE auth_registration_emails SET code_version=$2,code_hmac=$3,code_expires_at=$4,code_browser_binding_hash=$5,next_send_at=$6,
            failed_attempts=$7,failure_window_started_at=$8,updated_at=$9 WHERE id=$1`,
            [
              row.id,
              version,
              this.codeDigest(email, row.id, version, code),
              expiresAt,
              bindingHash,
              now + 60_000,
              reset ? 0 : row.failed_attempts,
              reset ? null : row.failure_window_started_at,
              now,
            ],
          )
          await tx.query(
            `INSERT INTO auth_registration_deliveries(id,registration_email_id,code_version,status,created_at) VALUES($1,$2,$3,'pending',$4)`,
            [attemptId, row.id, version, now],
          )
          return { attemptId, recipient: email, code, codeExpiresAt: expiresAt, challengeId: row.id, now }
        })
        reserved = true
        this.launchDelivery(delivery)
        return {
          status: 'accepted',
          challengeId: delivery.challengeId,
          serverTime: delivery.now,
          resendAvailableAt: delivery.now + 60_000,
        }
      } finally {
        if (!reserved) this.mailSlots--
      }
    })
  }
  verifyCode(
    challengeId: string,
    code: string,
    bindingHash: string,
  ): Promise<components['schemas']['RegistrationGrant']> {
    return this.track(async () => {
      const outcome = await this.d.db.transaction(async (tx) => {
        await capacityLock(tx)
        const row = (
            await tx.query<EmailRow>('SELECT * FROM auth_registration_emails WHERE id=$1 FOR UPDATE', [
              challengeId,
            ])
          ).rows[0],
          now = this.now()
        if (
          !row ||
          row.code_browser_binding_hash !== bindingHash ||
          !row.code_hmac ||
          row.code_expires_at === null ||
          row.code_expires_at <= now
        )
          throw new RegistrationError('REGISTRATION_CODE_INVALID')
        this.assertUnlocked(row, now)
        if (!equal(row.code_hmac, this.codeDigest(row.email, row.id, row.code_version, code))) {
          const reset =
            row.failure_window_started_at === null || row.failure_window_started_at + WINDOW <= now
          const count = reset ? 1 : row.failed_attempts + 1,
            start = reset ? now : row.failure_window_started_at!
          await tx.query(
            'UPDATE auth_registration_emails SET failed_attempts=$2,failure_window_started_at=$3,updated_at=$4 WHERE id=$1',
            [row.id, count, start, now],
          )
          return {
            error: new RegistrationError(
              count >= 5 ? 'REGISTRATION_CODE_LOCKED' : 'REGISTRATION_CODE_INVALID',
              count >= 5 ? seconds(start + WINDOW - now) : undefined,
            ),
          }
        }
        const grant = await this.insertGrantInside(tx, row.email, bindingHash)
        await tx.query(
          'UPDATE auth_registration_emails SET code_hmac=NULL,code_expires_at=NULL,code_browser_binding_hash=NULL,updated_at=$2 WHERE id=$1',
          [row.id, now],
        )
        return { grant }
      })
      if (outcome.error) throw outcome.error
      return outcome.grant!
    })
  }
  complete(
    input: { registrationToken: string; nickname: string; password: string },
    bindingHash: string,
  ): Promise<{ result: Result; created: boolean }> {
    return this.track(async () => {
      const tokenHash = digest(input.registrationToken),
        row = await this.d.db.transaction(async (tx) => {
          const row = (
            await tx.query<GrantRow>(
              'SELECT * FROM auth_registration_grants WHERE token_hash=$1 FOR UPDATE',
              [tokenHash],
            )
          ).rows[0]
          this.validateGrant(row, bindingHash)
          if (row!.state === 'completed') return row!
          if (row!.state === 'failed') throw new RegistrationError('REGISTRATION_RESTART_REQUIRED')
          if (row!.state === 'processing') throw new RegistrationError('REGISTRATION_IN_PROGRESS')
          await tx.query(
            `UPDATE auth_registration_grants SET state='processing',processing_started_at=$2,consumed_at=$2 WHERE id=$1`,
            [row!.id, this.now()],
          )
          return row!
        })
      if (row.state === 'completed') return { result: registrationResult(row), created: false }
      this.activeGrants.add(row.id)
      try {
        const passwordHash = await this.d.passwordHasher.hash(input.password)
        const result = await this.d.db.transaction(async (tx) => {
          const current = (
            await tx.query<GrantRow>('SELECT * FROM auth_registration_grants WHERE id=$1 FOR UPDATE', [
              row.id,
            ])
          ).rows[0]
          this.validateGrant(current, bindingHash)
          if (current!.state !== 'processing') throw new RegistrationError('REGISTRATION_RESTART_REQUIRED')
          const user = await this.d.auth.createAccountInside(
            tx,
            { email: current!.email, nickname: input.nickname },
            passwordHash,
          )
          if (current!.kind === 'cfx')
            await this.externalAccounts.createLinkFromGrantInside(tx, current!, user.id)
          await tx.query(
            `UPDATE auth_registration_grants SET state='completed',completed_at=$2,completed_user_id=$3 WHERE id=$1`,
            [row.id, this.now(), user.id],
          )
          return { status: 'registered' as const, userId: user.id, email: user.email }
        })
        return { result, created: true }
      } catch (error) {
        await this.d.db
          .query(`UPDATE auth_registration_grants SET state='failed' WHERE id=$1 AND state='processing'`, [
            row.id,
          ])
          .catch(() => {})
        if (uniqueViolation(error)) throw new AuthError('EMAIL_IN_USE')
        throw error
      } finally {
        this.activeGrants.delete(row.id)
      }
    })
  }
  signIn(
    context: CfxBrowserContext,
    identityTicket: string,
    bindingHash: string,
  ): Promise<components['schemas']['CfxSignInResult']> {
    return this.track(async () => {
      // No await before proof consumption: Cfx transitions ready -> consumed atomically.
      const identity = this.externalAccounts.consumeCfx(context, identityTicket)
      return this.externalAccounts.signInVerified(identity, bindingHash,
        (tx, email, binding, snapshot) => this.insertGrantInside(tx, email, binding, snapshot))
    })
  }
  private async insertGrantInside(
    tx: SqlExecutor,
    email: string,
    bindingHash: string,
    identity?: Pick<CfxIdentity, 'id' | 'username' | 'email'>,
  ) {
    await this.assertCount(tx, 'auth_registration_grants', 1024)
    const now = this.now(),
      rows = (
        await tx.query<{ browser_binding_hash: string }>(
          `SELECT browser_binding_hash FROM auth_registration_grants WHERE state IN ('active','processing') AND expires_at>$1`,
          [now],
        )
      ).rows
    if (rows.length >= 256 || rows.filter((row) => row.browser_binding_hash === bindingHash).length >= 3)
      throw new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED')
    const token = randomBytes(32).toString('base64url'),
      expiresAt = now + (identity ? 300_000 : 1_800_000)
    await tx.query(
      `INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,external_user_id,external_username,provider_email,state,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`,
      [
        randomUUID(),
        digest(token),
        bindingHash,
        identity ? 'cfx' : 'email',
        email,
        identity?.id ?? null,
        identity?.username ?? null,
        identity?.email ?? null,
        expiresAt,
        now,
      ],
    )
    return { registrationToken: token, email, expiresAt }
  }
  private validateGrant(row: GrantRow | undefined, bindingHash: string) {
    if (
      !row ||
      row.browser_binding_hash !== bindingHash ||
      (row.state === 'completed' ? row.completed_at! + REPLAY <= this.now() : row.expires_at <= this.now())
    )
      throw new RegistrationError('REGISTRATION_GRANT_INVALID')
  }
  private assertUnlocked(row: EmailRow, now: number) {
    if (
      row.failed_attempts >= 5 &&
      row.failure_window_started_at !== null &&
      row.failure_window_started_at + WINDOW > now
    )
      throw new RegistrationError(
        'REGISTRATION_CODE_LOCKED',
        seconds(row.failure_window_started_at + WINDOW - now),
      )
  }
  private codeDigest(email: string, id: string, version: number, code: string) {
    return createHmac('sha256', this.d.codeHmacKey)
      .update(JSON.stringify(['registration-code', email, id, version, code]))
      .digest('hex')
  }
  private async assertCount(
    tx: SqlExecutor,
    table: 'auth_registration_grants' | 'auth_registration_emails' | 'auth_registration_deliveries',
    limit: number,
  ) {
    if (Number((await tx.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count) >= limit)
      throw new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED')
  }
  private launchDelivery(input: {
    attemptId: string
    recipient: string
    code: string
    codeExpiresAt: number
  }) {
    const controller = new AbortController()
    this.controllers.add(controller)
    this.activeDeliveries.add(input.attemptId)
    if (this.closed) controller.abort()
    const settle = (status: 'sent' | 'failed') =>
      this.d.db
        .query(
          `UPDATE auth_registration_deliveries SET status=$2,finished_at=$3 WHERE id=$1 AND status='pending'`,
          [input.attemptId, status, this.now()],
        )
        .then(() => {})
    const timeout = setTimeout(() => {
      controller.abort()
      const write = settle('failed')
      this.observe(write)
    }, 20_000)
    timeout.unref()
    const work = Promise.resolve()
      .then(() => this.d.mailer!.send({ ...input, signal: controller.signal }))
      .then(
        () => settle(controller.signal.aborted ? 'failed' : 'sent'),
        () => settle('failed'),
      )
      .finally(() => {
        clearTimeout(timeout)
        this.controllers.delete(controller)
        this.activeDeliveries.delete(input.attemptId)
        this.mailSlots--
      })
    this.observe(work)
  }
  private observe(work: Promise<unknown>) {
    this.work.add(work)
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    )
  }
  private assertOpen() {
    if (this.closed) throw new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED')
  }
  private track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RegistrationError('REGISTRATION_CAPACITY_EXCEEDED'))
    const work = fn()
    this.observe(work)
    return work
  }
  private async cleanup() {
    await this.d.db.transaction(async (tx) => {
      await capacityLock(tx)
      let remaining = 25
      const now = this.now()
      const expiredEmails = (
        await tx.query<{ id: string }>(
          `SELECT id FROM auth_registration_emails WHERE code_expires_at<=$1 ORDER BY id LIMIT $2 FOR UPDATE`,
          [now, remaining],
        )
      ).rows
      for (const row of expiredEmails) {
        await tx.query(
          'UPDATE auth_registration_emails SET code_hmac=NULL,code_expires_at=NULL,code_browser_binding_hash=NULL WHERE id=$1',
          [row.id],
        )
        remaining--
      }
      const grants = (
        await tx.query<{ id: string }>(
          `SELECT id FROM auth_registration_grants WHERE ((state='completed' AND completed_at+$1<=$2) OR (state<>'completed' AND expires_at<=$2)) AND NOT(id=ANY($3::text[])) ORDER BY id LIMIT $4 FOR UPDATE`,
          [REPLAY, now, [...this.activeGrants], remaining],
        )
      ).rows
      for (const row of grants) {
        await tx.query('DELETE FROM auth_registration_grants WHERE id=$1', [row.id])
        remaining--
      }
      const deliveries = (
        await tx.query<{ id: string }>(
          `SELECT id FROM auth_registration_deliveries WHERE status<>'pending' AND finished_at+$1<=$2 AND NOT(id=ANY($3::text[])) ORDER BY id LIMIT $4 FOR UPDATE`,
          [86_400_000, now, [...this.activeDeliveries], remaining],
        )
      ).rows
      for (const row of deliveries) {
        await tx.query('DELETE FROM auth_registration_deliveries WHERE id=$1', [row.id])
        remaining--
      }
      const emails = (
        await tx.query<{ id: string }>(
          `SELECT e.id FROM auth_registration_emails e WHERE code_hmac IS NULL AND next_send_at<=$1 AND (failure_window_started_at IS NULL OR failure_window_started_at+$2<=$1)
        AND NOT EXISTS(SELECT 1 FROM auth_registration_deliveries d WHERE d.registration_email_id=e.id) AND NOT EXISTS(SELECT 1 FROM auth_registration_grants g WHERE g.email=e.email)
        ORDER BY e.id LIMIT $3 FOR UPDATE`,
          [now, WINDOW, remaining],
        )
      ).rows
      for (const row of emails) await tx.query('DELETE FROM auth_registration_emails WHERE id=$1', [row.id])
    })
  }
}
async function capacityLock(tx: SqlExecutor) {
  await tx.query('SELECT pg_advisory_xact_lock(163826, 1)')
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
function seconds(ms: number) {
  return Math.max(1, Math.ceil(ms / 1000))
}
function registrationResult(row: GrantRow): Result {
  return { status: 'registered', userId: row.completed_user_id!, email: row.email }
}
