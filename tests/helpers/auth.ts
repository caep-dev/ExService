import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AuthService, type AuthServiceDependencies } from '@server/src/modules/auth/service'
import type { PasswordHasher } from '@server/src/modules/auth/crypto'
import { ProfileService } from '@server/src/modules/profile/service'
import { JoinService } from '@server/src/domains/join/applications/service'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { IdentityLinkService } from '@server/src/modules/identity-links/service'
import {
  RegistrationService,
  type RegistrationMailer,
} from '@server/src/modules/registration/service'
import { CommunityService } from '@server/src/modules/communities/service'
import { createStorageModule } from '@server/src/modules/storage/factory'
import { parseStorageConfig } from '@server/src/modules/storage/config'
import { createNotificationModule } from '@server/src/modules/notifications/factory'
import { isolatedPostgres } from './postgres'
import { unavailableSupport } from './support'
export const testPasswordHasher: PasswordHasher = {
  async hash(password) {
    return `test-password:${password}`
  },
  async verify(password, encodedHash) {
    return encodedHash === `test-password:${password}`
  },
}
export function newJoinApplication(
  _email = 'member@example.com',
  _nickname = 'Applicant',
  qq = '001234',
) {
  return {
    qq,
    form: {
      applicationType: 'new' as const,
      birthDate: '2000-02-29',
      applicantCategory: '100' as const,
      department: 'leo' as const,
      freeTime: '每晚都有空',
      discoveryChannels: ['friends' as const],
      answers: {
        fiveMExperience: '没有接触过',
        emergencyRoleplayKnowledge: '了解',
        emergencyProceduresKnowledge: '学习中',
        rpUnderstanding: '扮演真实角色',
        frpUnderstanding: '遵循角色与场景',
      },
      commitments: {
        informationAccurate: true as const,
        obeyCommunityRules: true as const,
        acceptAcademyAttendanceConsequences: true as const,
      },
    },
  }
}
export function experiencedJoinApplication(email = 'experienced@example.com') {
  const common = newJoinApplication(email)
  return {
    ...common,
    form: {
      ...common.form,
      applicationType: 'experienced' as const,
      answers: {
        previousServer: 'Previous server',
        leaveReason: '寻找新社区',
        previousDepartment: '巡逻',
        lawEnforcementExperience: '有相关经历',
        highestRank: 'Officer',
        punishmentHistory: '无',
        deescalationEssay: '😀'.repeat(150),
        discretionEssay: '自'.repeat(150),
        transferReason: '继续学习',
      },
      commitments: {
        informationAccurate: true as const,
        obeyCommunityRules: true as const,
      },
    },
  }
}
export async function createTestAuth(
  overrides: Partial<AuthServiceDependencies> & {
    createUserId?: () => string
  } = {},
) {
  const isolated = await isolatedPostgres(),
    { db } = isolated
  let randomCounter = 0,
    idCounter = 0,
    userCounter = 0,
    currentTime = 1_800_000_000_000
  const now = overrides.now ?? (() => currentTime),
    createId = () => `20000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`
  const createUserId =
      overrides.createUserId ??
      (() => `10000000-0000-4000-8000-${String(++userCounter).padStart(12, '0')}`),
    passwordHasher = overrides.passwordHasher ?? testPasswordHasher
  const authServices = new AuthService({
    now,
    passwordHasher,
    randomBytes: (length: number) => {
      const bytes = Buffer.alloc(length)
      bytes.writeUInt32BE(++randomCounter, Math.max(0, length - 4))
      return bytes
    },
    ...overrides,
    db,
  })
  const cfxServices = createCfxServices({ config: { enabled: false }, now })
  const identityLinkServices = new IdentityLinkService({
    db,
    auth: authServices,
    cfx: cfxServices,
    now,
  })
  const deliveries: Array<Parameters<RegistrationMailer['send']>[0]> = []
  const registrationServices = new RegistrationService({
    db,
    auth: authServices,
    identityLinks: identityLinkServices,
    cfx: cfxServices,
    passwordHasher,
    now,
    codeHmacKey: Buffer.alloc(32, 7),
    mailer: {
      send: async (mail) => {
        deliveries.push(mail)
      },
    },
  })
  const communityServices = new CommunityService({
    db,
    authServices,
    identityLinkServices,
    now,
  })
  const notifications = createNotificationModule({
    db,
    tokenKey: Buffer.alloc(32, 3),
    now,
  })
  const joinServices = new JoinService({
    db,
    authServices,
    communityServices,
    identityLinkServices,
    notifications,
    now,
    createId,
  })
  const avatarDirectory = mkdtempSync(resolve(tmpdir(), 'exwebsite-avatars-')),
    storageDirectory = mkdtempSync(resolve(tmpdir(), 'exwebsite-storage-'))
  const profileServices = new ProfileService(
    db,
    avatarDirectory,
    'http://127.0.0.1:8080/api/avatars',
  )
  const storageServices = createStorageModule({
    config: parseStorageConfig({}, { dataRoot: storageDirectory }),
  })
  return {
    db,
    connectionString: isolated.connectionString,
    schema: isolated.schema,
    authServices,
    cfxServices,
    identityLinkServices,
    registrationServices,
    communityServices,
    joinServices,
    profileServices,
    storageServices,
    notifications,
    ...unavailableSupport(db, profileServices),
    publicOrigin: 'http://127.0.0.1:8080',
    production: false,
    avatarDirectory,
    deliveries,
    now,
    async seedUser(input: { email: string; nickname: string; password: string }) {
      const id = createUserId(),
        hash = await passwordHasher.hash(input.password)
      await db.query(
        'INSERT INTO auth_users(id,email,nickname,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',
        [id, input.email.trim().toLowerCase(), input.nickname.trim(), hash, now()],
      )
      return id
    },
    advance(milliseconds: number) {
      currentTime += milliseconds
    },
    async close() {
      await registrationServices.close()
      await identityLinkServices.close()
      await cfxServices.close()
      await isolated.close()
      rmSync(avatarDirectory, { recursive: true, force: true })
      rmSync(storageDirectory, { recursive: true, force: true })
    },
  }
}
export type TestAuth = Awaited<ReturnType<typeof createTestAuth>>
/** Existing-account setup for unrelated auth/profile regressions; no retired registration route. */
export async function registerInvited(fixture: TestAuth, email = 'member@example.com') {
  await fixture.seedUser({
    email,
    nickname: 'Member',
    password: 'valid password',
  })
  return { status: 'registered' as const, email }
}
export async function joinActor(f: TestAuth, email = 'applicant@example.com', reviewer = false) {
  const id = await f.seedUser({
    email,
    nickname: 'Applicant',
    password: 'valid password',
  })
  const login = await f.authServices.login({
      email,
      password: 'valid password',
    }),
    session = await f.authServices.authenticateToken(login.token)
  await f.db.transaction((tx) =>
    f.identityLinkServices.createInside(
      tx,
      {
        id: String(parseInt(id.slice(-12), 10) + 1000),
        username: 'External',
        email,
      },
      id,
    ),
  )
  if (reviewer)
    await f.db.query(
      'INSERT INTO community_reviewers(community_id,user_id,granted_by_user_id,granted_at) VALUES($1,$2,$2,$3)',
      ['rifling-911', id, f.now()],
    )
  return {
    id,
    session,
    authorization: `Bearer ${login.token}`,
    headers: { authorization: `Bearer ${login.token}`, origin: f.publicOrigin },
  }
}
export async function joinSnapshot(f: TestAuth) {
  const result: Record<string, unknown[]> = {}
  for (const table of [
    'join_applications',
    'join_application_email_registry',
    'join_application_forms',
    'join_application_attachments',
    'join_invitations',
    'join_email_controls',
    'join_delivery_attempts',
    'auth_users',
    'auth_sessions',
    'auth_sso_requests',
    'community_groups',
    'community_group_memberships',
    'community_memberships',
    'notification_events',
    'notification_contents',
  ])
    result[table] = (await f.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows
  return result
}
