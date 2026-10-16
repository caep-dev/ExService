import { createHash, randomUUID } from 'node:crypto'
import { AuthError } from '@server/src/modules/auth/errors.js'
import { ScryptPasswordHasher, secureRandom, type PasswordHasher } from '@server/src/modules/auth/crypto.js'
import type { AppDatabase, SqlExecutor } from '@server/src/db/client.js'

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const SSO_LIFETIME_MS = 10 * 60 * 1000
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000
const DUMMY_PASSWORD_HASH = 'scrypt$v1$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$87xuP_zsviL_8xlYE4GGdN5CefEvk9cTaJi8aTN_W93HjYfwLqp9zNpi6WxxRJHq5-2MjYVQYA-ziEFf-XFU1Q'

export interface AuthServiceDependencies {
  db: AppDatabase
  publicAvatarBaseUrl?: string
  now?: () => number
  randomBytes?: (length: number) => Buffer
  passwordHasher?: PasswordHasher
}
export interface LoginInput { email: string; password: string }
export interface SessionIdentity {
  id: string; tokenHash: string; userId: string; email: string; nickname: string; expiresAt: number
}
interface UserRow { id: string; email: string; nickname: string; password_hash: string; disabled_at: number | null }
interface SsoRow {
  id_hash: string; created_at: number; expires_at: number; status: 'pending' | 'completed'
  user_id: string | null; completed_at: number | null
}

export class AuthService {
  private readonly db: AppDatabase
  private readonly now: () => number
  private readonly randomBytes: (length: number) => Buffer
  private readonly passwordHasher: PasswordHasher
  private readonly publicAvatarBaseUrl: string

  constructor(dependencies: AuthServiceDependencies) {
    this.db = dependencies.db
    this.now = dependencies.now ?? Date.now
    this.randomBytes = dependencies.randomBytes ?? secureRandom.bytes
    this.passwordHasher = dependencies.passwordHasher ?? new ScryptPasswordHasher()
    this.publicAvatarBaseUrl = dependencies.publicAvatarBaseUrl ?? 'http://127.0.0.1:8080/api/avatars'
  }

  async login(input: LoginInput) {
    const email = normalizeEmail(input.email)
    assertPassword(input.password)
    const user = await this.findUserByEmail(email)
    const valid = await this.passwordHasher.verify(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (!user || !valid || user.disabled_at !== null) throw new AuthError('INVALID_CREDENTIALS')
    return this.db.transaction(async tx => {
      const current = (await tx.query<UserRow>(
        'SELECT * FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [user.id])).rows[0]
      if (!current || current.disabled_at !== null || current.email !== email ||
        current.password_hash !== user.password_hash) throw new AuthError('INVALID_CREDENTIALS')
      return this.createSessionInside(tx, user.id)
    })
  }

  async createAccountInside(tx: SqlExecutor, input: { email: string; nickname: string }, passwordHash: string) {
    const id = randomUUID(), email = normalizeEmail(input.email)
    await tx.query(`INSERT INTO auth_users (id, email, nickname, password_hash, created_at)
      VALUES ($1, $2, $3, $4, $5)`, [id, email, input.nickname, passwordHash, this.now()])
    return { id, email }
  }

  async createSessionInside(tx: SqlExecutor, userId: string) {
    const user = (await tx.query<{ disabled_at: number | null }>(
      'SELECT disabled_at FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [userId])).rows[0]
    if (!user || user.disabled_at !== null) throw new AuthError('SESSION_INVALID')
    const token = this.createOpaqueIdentifier(), now = this.now(), expiresAt = now + SESSION_LIFETIME_MS
    await tx.query(`INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, revoked_at)
      VALUES ($1, $2, $3, $4, NULL)`, [digestOpaque(token), userId, now, expiresAt])
    return { token, expiresAt }
  }

  async authenticateToken(token: string): Promise<SessionIdentity> {
    const now = this.now()
    const result = await this.db.query<{
      id: string; token_hash: string; user_id: string; expires_at: number; revoked_at: number | null; disabled_at: number | null
      email: string; nickname: string
    }>(`SELECT s.id, s.token_hash, s.user_id, s.expires_at, s.revoked_at, u.email, u.nickname, u.disabled_at
      FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = $1`, [digestOpaque(token)])
    const row = result.rows[0]
    if (!row || row.revoked_at !== null || row.disabled_at !== null || now >= row.expires_at) throw new AuthError('SESSION_INVALID')
    return { id: row.id, tokenHash: row.token_hash, userId: row.user_id, email: row.email, nickname: row.nickname, expiresAt: row.expires_at }
  }

  async logout(session: SessionIdentity) {
    await this.db.transaction(async tx => {
      await this.assertSessionCurrent(session, tx, true)
      await this.revokeLockedSession(tx, session.id, session.userId, this.now())
    })
    return { status: 'signed-out' as const }
  }

  async createSsoRequest() {
    const ssoRequestId = this.createOpaqueIdentifier(), now = this.now(), expiresAt = now + SSO_LIFETIME_MS
    await this.cleanup(now)
    await this.db.query(`INSERT INTO auth_sso_requests (id_hash, created_at, expires_at, status, user_id, completed_at)
      VALUES ($1, $2, $3, 'pending', NULL, NULL)`, [digestOpaque(ssoRequestId), now, expiresAt])
    return { ssoRequestId, expiresAt }
  }

  async inspectSsoRequest(ssoRequestId: string) {
    const now = this.now(), row = await this.getSsoRequest(digestOpaque(ssoRequestId))
    if (!row) throw new AuthError('SSO_REQUEST_NOT_FOUND')
    if (now >= row.expires_at) throw new AuthError('SSO_REQUEST_EXPIRED')
    return { ssoRequestId, status: row.status, expiresAt: row.expires_at, serverTime: now }
  }

  async loginForSso(input: LoginInput & { ssoRequestId: string }) {
    const email = normalizeEmail(input.email)
    assertPassword(input.password)
    const user = await this.findUserByEmail(email)
    const valid = await this.passwordHasher.verify(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (!user || !valid || user.disabled_at !== null) throw new AuthError('INVALID_CREDENTIALS')
    return this.completeSsoRequest(input.ssoRequestId, user.id)
  }

  async confirmSsoWithSession(ssoRequestId: string, session: SessionIdentity) {
    return this.completeSsoRequest(ssoRequestId, session.userId, session)
  }

  async inspectSsoRequestForCli(ssoRequestId: string) {
    const row = await this.getSsoRequest(digestOpaque(ssoRequestId))
    if (!row) return { status: 'not-found' as const }
    if (row.status === 'pending' && this.now() >= row.expires_at) return { status: 'expired' as const, expiresAt: row.expires_at }
    return { status: row.status, expiresAt: row.expires_at, userId: row.user_id }
  }

  private async completeSsoRequest(ssoRequestId: string, userId: string, session?: SessionIdentity) {
    const idHash = digestOpaque(ssoRequestId)
    return this.db.transaction(async tx => {
      // This user row is the cross-process admission barrier for disable.
      // NO KEY UPDATE also allows outbox foreign-key KEY SHARE locks.
      const user = (await tx.query<{ disabled_at: number | null }>(
        'SELECT disabled_at FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [userId])).rows[0]
      if (!user || user.disabled_at !== null) throw new AuthError('SESSION_INVALID')
      if (session) await this.assertSessionCurrent(session, tx, true)
      const row = await this.getSsoRequest(idHash, tx, true)
      const now = this.now()
      if (!row) throw new AuthError('SSO_REQUEST_NOT_FOUND')
      if (now >= row.expires_at) throw new AuthError('SSO_REQUEST_EXPIRED')
      if (row.status === 'completed') {
        if (row.user_id !== userId) throw new AuthError('SSO_ACCOUNT_CONFLICT')
        return { status: 'completed' as const, ssoRequestId }
      }
      const result = await tx.query(`UPDATE auth_sso_requests SET status = 'completed', user_id = $1, completed_at = $2
        WHERE id_hash = $3 AND status = 'pending'`, [userId, now, idHash])
      if (result.rowCount !== 1) throw new AuthError('SSO_ACCOUNT_CONFLICT')
      return { status: 'completed' as const, ssoRequestId }
    })
  }

  async assertSessionCurrent(session: SessionIdentity, executor: SqlExecutor = this.db, lock = false): Promise<void> {
    const result = await executor.query<{ revoked_at: number | null; expires_at: number; disabled_at: number | null }>(
      `SELECT s.revoked_at, s.expires_at, u.disabled_at FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.user_id = $2${lock ? ' FOR UPDATE OF s' : ''}`,
      [session.tokenHash, session.userId])
    const row = result.rows[0]
    if (!row || row.revoked_at !== null || row.disabled_at !== null || this.now() >= row.expires_at) throw new AuthError('SESSION_INVALID')
  }

  async disableUser(userId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const user = (await tx.query<{ disabled_at: number | null }>(
        'SELECT disabled_at FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [userId])).rows[0]
      if (!user) throw new AuthError('IDENTITY_NOT_FOUND')
      if (user.disabled_at !== null) return
      const now = this.now()
      // Consent holds the same session lock when it creates a binding.
      await tx.query('SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY id FOR UPDATE', [userId])
      const bindings = await tx.query<{ client_id: string; hydra_sid: string; session_id: string }>(
        `SELECT client_id, hydra_sid, session_id FROM auth_oidc_bindings
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY client_id, hydra_sid FOR UPDATE`, [userId])
      await tx.query('UPDATE auth_users SET disabled_at = $1 WHERE id = $2', [now, userId])
      await tx.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE user_id = $2', [now, userId])
      await tx.query('UPDATE auth_oidc_bindings SET revoked_at = COALESCE(revoked_at, $1) WHERE user_id = $2', [now, userId])
      const targets = bindings.rows.map(binding => ({
        clientId: binding.client_id, hydraSid: binding.hydra_sid,
        sessionId: binding.session_id, deliveryEventId: randomUUID(),
      }))
      await tx.query(`INSERT INTO auth_identity_outbox
        (event_id, kind, session_id, user_id, target_bindings, created_at, next_attempt_at, delivered_targets)
        VALUES ($1, 'user', NULL, $2, $3, $4, $4, '[]')`,
      [randomUUID(), userId, JSON.stringify(targets), now])
    })
  }

  async enableUser(userId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const user = (await tx.query<{ disabled_at: number | null }>(
        'SELECT disabled_at FROM auth_users WHERE id = $1 FOR NO KEY UPDATE', [userId])).rows[0]
      if (!user) throw new AuthError('IDENTITY_NOT_FOUND')
      if (user.disabled_at !== null) await tx.query(
        'UPDATE auth_users SET disabled_at = NULL WHERE id = $1', [userId])
    })
  }

  private async getSsoRequest(idHash: string, executor: SqlExecutor = this.db, lock = false): Promise<SsoRow | undefined> {
    const result = await executor.query<SsoRow>(`SELECT * FROM auth_sso_requests WHERE id_hash = $1${lock ? ' FOR UPDATE' : ''}`, [idHash])
    return result.rows[0]
  }
  private async findUserByEmail(email: string): Promise<UserRow | undefined> {
    return (await this.db.query<UserRow>('SELECT * FROM auth_users WHERE email = $1', [email])).rows[0]
  }
  private async cleanup(now: number): Promise<void> {
    await this.db.transaction(async tx => {
      // Lock every row later eligible for deletion in the same order as
      // disableUser. Otherwise an expired row held here and an already
      // revoked row held by disable can deadlock during the DELETE below.
      const candidates = await tx.query<{
        id: string; user_id: string; expires_at: number; revoked_at: number | null
      }>(`SELECT id, user_id, expires_at, revoked_at FROM auth_sessions
        WHERE expires_at <= $1 OR revoked_at IS NOT NULL ORDER BY id FOR UPDATE`, [now])
      for (const row of candidates.rows) {
        if (row.expires_at <= now && row.revoked_at === null) {
          await this.revokeLockedSession(tx, row.id, row.user_id, now)
        }
      }
      await tx.query('DELETE FROM auth_oidc_flows WHERE expires_at <= $1', [now])
      await tx.query('DELETE FROM auth_identity_outbox WHERE completed_at IS NOT NULL AND completed_at + $1 <= $2',
        [TOMBSTONE_RETENTION_MS, now])
      await tx.query(`DELETE FROM auth_oidc_bindings b WHERE revoked_at IS NOT NULL AND revoked_at + $1 <= $2
        AND NOT EXISTS (SELECT 1 FROM auth_identity_outbox o WHERE o.session_id = b.session_id)
        AND NOT EXISTS (SELECT 1 FROM auth_identity_outbox o WHERE o.kind = 'user' AND o.user_id = b.user_id
          AND o.target_bindings::jsonb @> jsonb_build_array(jsonb_build_object(
            'clientId', b.client_id, 'hydraSid', b.hydra_sid, 'sessionId', b.session_id)))`,
        [TOMBSTONE_RETENTION_MS, now])
      await tx.query(`DELETE FROM auth_sessions s WHERE (expires_at <= $1 OR revoked_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM auth_oidc_bindings b WHERE b.session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM auth_oidc_flows f WHERE f.session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM auth_identity_outbox o WHERE o.session_id = s.id)`, [now])
      await tx.query('DELETE FROM auth_sso_requests WHERE expires_at + $1 <= $2', [TOMBSTONE_RETENTION_MS, now])
    })
  }

  async checkLinkedSession(clientId: string, hydraSid: string, subject: string) {
    const result = await this.db.query<{
      session_id: string; user_id: string; expires_at: number; revoked_at: number | null
      binding_revoked_at: number | null; disabled_at: number | null; nickname: string
      email: string; avatar_key: string | null; profile_version: number
    }>(`SELECT b.session_id, b.user_id, b.revoked_at AS binding_revoked_at,
      s.expires_at, s.revoked_at, u.disabled_at, u.nickname, u.email, u.avatar_key, u.profile_version
      FROM auth_oidc_bindings b JOIN auth_sessions s ON s.id = b.session_id
      JOIN auth_users u ON u.id = b.user_id
      WHERE b.client_id = $1 AND b.hydra_sid = $2 AND b.user_id = $3`, [clientId, hydraSid, subject])
    const row = result.rows[0]
    if (!row) return { active: false as const, reason: 'unknown' as const }
    if (row.disabled_at !== null) return { active: false as const, reason: 'disabled' as const }
    if (row.revoked_at !== null || row.binding_revoked_at !== null) return { active: false as const, reason: 'revoked' as const }
    if (this.now() >= row.expires_at) return { active: false as const, reason: 'expired' as const }
    return { active: true as const, sessionId: row.session_id, userId: row.user_id, expiresAt: row.expires_at,
      profile: { nickname: row.nickname, email: row.email,
        avatarUrl: row.avatar_key === null ? null : `${this.publicAvatarBaseUrl}/${row.avatar_key}`,
        version: row.profile_version } }
  }

  async revokeLinkedSession(clientId: string, hydraSid: string, subject: string, _requestId: string = randomUUID()) {
    await this.db.transaction(async tx => {
      const binding = await tx.query<{ session_id: string; user_id: string }>(
        `SELECT session_id, user_id FROM auth_oidc_bindings WHERE client_id = $1 AND hydra_sid = $2 AND user_id = $3`,
        [clientId, hydraSid, subject])
      if (!binding.rows[0]) return
      const session = await tx.query<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM auth_sessions WHERE id = $1 FOR UPDATE', [binding.rows[0].session_id])
      if (session.rows[0]?.revoked_at !== null && session.rows[0]?.revoked_at !== undefined) return
      await this.revokeLockedSession(tx, binding.rows[0].session_id, binding.rows[0].user_id, this.now())
    })
    return { revoked: true as const }
  }

  async inspectIdentityUser(userId: string) {
    const row = (await this.db.query<{ id: string; nickname: string; email: string;
      avatar_key: string | null; profile_version: number }>(
      `SELECT id, nickname, email, avatar_key, profile_version FROM auth_users
       WHERE id = $1 AND disabled_at IS NULL`, [userId])).rows[0]
    if (!row) return undefined
    return { id: row.id, nickname: row.nickname, email: row.email,
      avatarUrl: row.avatar_key === null ? null : `${this.publicAvatarBaseUrl}/${row.avatar_key}`,
      profileVersion: row.profile_version }
  }

  private async revokeLockedSession(tx: SqlExecutor, sessionId: string, userId: string, now: number,
    eventId: string = randomUUID()): Promise<void> {
    await tx.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2', [now, sessionId])
    const bindings = await tx.query<{ client_id: string; hydra_sid: string }>(
      'SELECT client_id, hydra_sid FROM auth_oidc_bindings WHERE session_id = $1 AND revoked_at IS NULL', [sessionId])
    await tx.query('UPDATE auth_oidc_bindings SET revoked_at = COALESCE(revoked_at, $1) WHERE session_id = $2',
      [now, sessionId])
    if (bindings.rows.length > 0) {
      const targets = bindings.rows.map(row => ({ clientId: row.client_id, hydraSid: row.hydra_sid }))
      await tx.query(`INSERT INTO auth_identity_outbox
        (event_id, kind, session_id, user_id, target_bindings, created_at, next_attempt_at, delivered_targets)
        VALUES ($1, 'session', $2, $3, $4, $5, $5, '[]')`,
      [eventId, sessionId, userId, JSON.stringify(targets), now])
    }
  }
  private createOpaqueIdentifier(): string { return this.randomBytes(32).toString('base64url') }
}

export async function assertAuthSchemaAvailable(db: SqlExecutor): Promise<void> {
  const result = await db.query<{ tablename: string }>(`SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
    [['auth_users', 'auth_sessions', 'auth_sso_requests', 'auth_oidc_flows',
      'auth_oidc_bindings', 'auth_identity_outbox']])
  if (result.rows.length !== 6) throw new Error('认证数据表缺失；请运行 pnpm db:migrate。')
}

function digestOpaque(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (Array.from(email).length > 254) throw new AuthError('BAD_REQUEST')
  return email
}
function assertPassword(password: string): void {
  const length = Array.from(password).length
  if (length < 8 || length > 64) throw new AuthError('BAD_REQUEST')
}
