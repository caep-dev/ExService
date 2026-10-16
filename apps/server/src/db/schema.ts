import { sql } from 'drizzle-orm'
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, uniqueIndex, customType } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const supportFeedbackSubmissions = pgTable('support_feedback_submissions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  submissionKey: text('submission_key').notNull(), nicknameSnapshot: text('nickname_snapshot').notNull(),
  formKind: text('form_kind').notNull(), formVersion: integer('form_version').notNull(),
  contentRuleVersion: integer('content_rule_version').notNull(), formJson: text('form_json').notNull(),
  userMarkdown: text('user_markdown').notNull(), finalMarkdown: text('final_markdown').notNull(),
  payloadSha256: text('payload_sha256').notNull(), taskPayloadJson: text('task_payload_json').notNull(), taskPayloadSha256: text('task_payload_sha256').notNull(), revision: bigint('revision', { mode: 'number' }).notNull(),
  status: text('status').notNull(), attachmentCount: integer('attachment_count').notNull(),
  totalAttachmentBytes: bigint('total_attachment_bytes', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(), receiveExpiresAt: bigint('receive_expires_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(), clickupTaskId: text('clickup_task_id'), targetListId: text('target_list_id').notNull(),
  attemptId: text('attempt_id'), attemptKind: text('attempt_kind'), attemptAttachmentId: text('attempt_attachment_id'),
  attemptStartedAt: bigint('attempt_started_at', { mode: 'number' }), attemptExpiresAt: bigint('attempt_expires_at', { mode: 'number' }),
  attemptOwnerBootId: text('attempt_owner_boot_id'), failureCode: text('failure_code'), failurePhase: text('failure_phase'),
  failureAttachmentId: text('failure_attachment_id'), retryNotBefore: bigint('retry_not_before', { mode: 'number' }),
  maintenanceResolutionJson: text('maintenance_resolution_json'),
}, t => [
  uniqueIndex('support_feedback_key_unique').on(t.userId, t.submissionKey),
  uniqueIndex('support_feedback_task_unique').on(t.clickupTaskId),
  index('support_feedback_user_created_idx').on(t.userId, t.createdAt),
  check('support_feedback_form_check', sql`((${t.formKind} in ('bug','feature','asset','request','content','campaign') and ${t.formVersion}=2) or (${t.formKind} in ('suggestion','complaint') and ${t.formVersion}=3)) and ${t.contentRuleVersion}=1`),
  check('support_feedback_status_check', sql`${t.status} in ('receiving','ready','creating','uploading','failed','verification_required','completed')`),
  check('support_feedback_revision_check', sql`${t.revision} between 0 and 9007199254740991`),
  check('support_feedback_count_check', sql`${t.attachmentCount} between 0 and 5 and ${t.totalAttachmentBytes} between 0 and 104857600`),
  check('support_feedback_digest_check', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  check('support_feedback_task_payload_digest_check', sql`${t.taskPayloadSha256} ~ '^[0-9a-f]{64}$'`),
  check('support_feedback_time_check', sql`${t.createdAt} between 0 and 9007199168340991 and ${t.receiveExpiresAt}=${t.createdAt}+86400000 and ${t.updatedAt} between ${t.createdAt} and 9007199254740991 and (${t.retryNotBefore} is null or ${t.retryNotBefore} between 0 and 9007199254740991)`),
  check('support_feedback_content_check', sql`octet_length(${t.userMarkdown}) between 1 and 65536 and octet_length(${t.finalMarkdown}) between 1 and 66560`),
  check('support_feedback_attempt_check', sql`(
    ${t.attemptId} is null and ${t.attemptKind} is null and ${t.attemptAttachmentId} is null and ${t.attemptStartedAt} is null and ${t.attemptExpiresAt} is null and ${t.attemptOwnerBootId} is null
  ) or (
    ${t.attemptId} is not null and ${t.attemptKind} is not null and ${t.attemptOwnerBootId} is not null and ${t.attemptStartedAt} is not null and ${t.attemptExpiresAt} is not null and ${t.attemptStartedAt} between 0 and 9007199254740991 and ${t.attemptExpiresAt} between ${t.attemptStartedAt} and 9007199254740991 and
    ((${t.attemptKind}='create_task' and ${t.attemptAttachmentId} is null) or (${t.attemptKind}='upload_attachment' and ${t.attemptAttachmentId} is not null and ${t.clickupTaskId} is not null))
  )`),
  check('support_feedback_failure_check', sql`(${t.failureCode} is null and ${t.failurePhase} is null and ${t.failureAttachmentId} is null and ${t.retryNotBefore} is null) or (
    ${t.failureCode} is not null and ${t.failurePhase} is not null and ${t.failureCode} in ('UPSTREAM_REJECTED','UPSTREAM_RATE_LIMITED','UPSTREAM_CONFIGURATION','UPSTREAM_UNKNOWN') and
    ((${t.failurePhase}='create_task' and ${t.failureAttachmentId} is null) or (${t.failurePhase}='upload_attachment' and ${t.failureAttachmentId} is not null and ${t.clickupTaskId} is not null))
  )`),
  check('support_feedback_task_check', sql`${t.clickupTaskId} is null or ${t.clickupTaskId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
  check('support_feedback_completed_check', sql`${t.status}<>'completed' or (${t.clickupTaskId} is not null and ${t.attemptId} is null and ${t.failureCode} is null)`),
])

export const supportFeedbackAttachments = pgTable('support_feedback_attachments', {
  submissionId: text('submission_id').notNull().references(() => supportFeedbackSubmissions.id, { onDelete: 'restrict' }),
  id: text('id').notNull(), ordinal: integer('ordinal').notNull(), originalName: text('original_name').notNull(),
  contentType: text('content_type').notNull(), byteLength: integer('byte_length').notNull(), sha256: text('sha256').notNull(),
  bytes: bytea('bytes'), status: text('status').notNull(), remoteAttachmentId: text('remote_attachment_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(), updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, t => [
  primaryKey({ columns: [t.submissionId, t.id] }),
  uniqueIndex('support_attachment_ordinal_unique').on(t.submissionId, t.ordinal),
  uniqueIndex('support_attachment_remote_unique').on(t.submissionId, t.remoteAttachmentId),
  check('support_attachment_ordinal_check', sql`${t.ordinal} between 0 and 4`),
  check('support_attachment_length_check', sql`${t.byteLength} between 1 and 20971520`),
  check('support_attachment_sha_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('support_attachment_time_check', sql`${t.createdAt} between 0 and 9007199254740991 and ${t.updatedAt} between ${t.createdAt} and 9007199254740991`),
  check('support_attachment_metadata_check', sql`char_length(${t.originalName}) between 1 and 255 and char_length(${t.contentType}) between 1 and 127 and (${t.remoteAttachmentId} is null or char_length(${t.remoteAttachmentId}) between 1 and 256)`),
  check('support_attachment_bytes_check', sql`(
    ${t.status}='expected' and ${t.bytes} is null and ${t.remoteAttachmentId} is null
  ) or (
    ${t.status} in ('received','uploading','failed','verification_required') and ${t.bytes} is not null and octet_length(${t.bytes})=${t.byteLength} and ${t.remoteAttachmentId} is null
  ) or (
    ${t.status}='uploaded' and ${t.remoteAttachmentId} is not null and ${t.bytes} is null
  )`),
])

export const authUsers = pgTable(
  'auth_users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    nickname: text('nickname').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    qq: text('qq'),
    fivemId: text('fivem_id'),
    avatarKey: text('avatar_key'),
    disabledAt: bigint('disabled_at', { mode: 'number' }),
    profileVersion: integer('profile_version').notNull().default(0),
  },
  (table) => [
    uniqueIndex('auth_users_avatar_key_unique').on(table.avatarKey),
    check('auth_users_profile_version_check', sql`${table.profileVersion} >= 0`),
  ],
)

export const authSessions = pgTable(
  'auth_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    id: text('id').notNull().default(sql`gen_random_uuid()::text`),
    userId: text('user_id').notNull().references(() => authUsers.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (table) => [
    index('auth_sessions_user_id_idx').on(table.userId),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
    uniqueIndex('auth_sessions_id_unique').on(table.id),
    uniqueIndex('auth_sessions_id_user_id_unique').on(table.id, table.userId),
  ],
)

export const authOidcFlows = pgTable('auth_oidc_flows', {
  phase: text('phase').notNull(),
  challengeHash: text('challenge_hash').notNull(),
  sessionId: text('session_id').notNull().references(() => authSessions.id, { onDelete: 'restrict' }),
  clientId: text('client_id').notNull(),
  hydraSid: text('hydra_sid'),
  state: text('state').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  encryptedRedirect: text('encrypted_redirect'),
}, table => [
  primaryKey({ columns: [table.phase, table.challengeHash] }),
  check('auth_oidc_flows_phase_check', sql`${table.phase} in ('login', 'consent')`),
  check('auth_oidc_flows_state_check', sql`${table.state} in ('processing', 'completed', 'restart_required')`),
  index('auth_oidc_flows_expires_at_idx').on(table.expiresAt),
])

export const authOidcBindings = pgTable('auth_oidc_bindings', {
  clientId: text('client_id').notNull(),
  hydraSid: text('hydra_sid').notNull(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.clientId, table.hydraSid] }),
  foreignKey({ columns: [table.sessionId, table.userId],
    foreignColumns: [authSessions.id, authSessions.userId],
    name: 'auth_oidc_bindings_session_owner_fk' }).onDelete('restrict'),
  index('auth_oidc_bindings_session_idx').on(table.sessionId),
  index('auth_oidc_bindings_user_idx').on(table.userId),
])

export const authIdentityOutbox = pgTable('auth_identity_outbox', {
  eventId: text('event_id').primaryKey(),
  kind: text('kind').notNull(),
  sessionId: text('session_id').references(() => authSessions.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  targetBindings: text('target_bindings').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: bigint('next_attempt_at', { mode: 'number' }).notNull(),
  deliveredTargets: text('delivered_targets').notNull(),
  completedAt: bigint('completed_at', { mode: 'number' }),
}, table => [
  check('auth_identity_outbox_kind_check', sql`${table.kind} in ('session', 'user')`),
  check('auth_identity_outbox_attempts_check', sql`${table.attempts} >= 0`),
  index('auth_identity_outbox_due_idx').on(table.completedAt, table.nextAttemptAt),
])

export const authSsoRequests = pgTable(
  'auth_sso_requests',
  {
    idHash: text('id_hash').primaryKey(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    userId: text('user_id').references(() => authUsers.id),
    completedAt: bigint('completed_at', { mode: 'number' }),
  },
  (table) => [
    check('auth_sso_requests_status_check', sql`${table.status} in ('pending', 'completed')`),
    index('auth_sso_requests_expires_at_idx').on(table.expiresAt),
  ],
)

export const communityGroups = pgTable('community_groups', {
  code: text('code').primaryKey(),
  displayName: text('display_name').notNull(),
})

export const communityGroupMemberships = pgTable(
  'community_group_memberships',
  {
    userId: text('user_id').notNull().references(() => authUsers.id),
    groupCode: text('group_code').notNull().references(() => communityGroups.code),
  },
  (table) => [primaryKey({ columns: [table.userId, table.groupCode] })],
)

export const authIdentityLinks = pgTable('auth_identity_links', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => authUsers.id),
  provider: text('provider').notNull(), externalUserId: text('external_user_id').notNull(),
  externalUsername: text('external_username').notNull(), providerEmail: text('provider_email'),
  linkedAt: bigint('linked_at', { mode: 'number' }).notNull(),
}, table => [
  uniqueIndex('auth_identity_links_subject_unique').on(table.provider, table.externalUserId),
  uniqueIndex('auth_identity_links_user_provider_unique').on(table.userId, table.provider),
  check('auth_identity_links_provider_check', sql`${table.provider} = 'cfx'`),
  check('auth_identity_links_subject_check', sql`${table.externalUserId} ~ '^[1-9][0-9]*$'`),
])
export const authRegistrationEmails = pgTable('auth_registration_emails', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), codeVersion: integer('code_version').notNull().default(0),
  codeHmac: text('code_hmac'), codeExpiresAt: bigint('code_expires_at', { mode: 'number' }), codeBrowserBindingHash: text('code_browser_binding_hash'),
  nextSendAt: bigint('next_send_at', { mode: 'number' }).notNull(), failedAttempts: integer('failed_attempts').notNull().default(0),
  failureWindowStartedAt: bigint('failure_window_started_at', { mode: 'number' }), updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, table => [
  check('auth_registration_emails_version_check', sql`${table.codeVersion} >= 0`),
  check('auth_registration_emails_failures_check', sql`${table.failedAttempts} between 0 and 5`),
  check('auth_registration_emails_material_check', sql`(${table.codeHmac} is null and ${table.codeExpiresAt} is null and ${table.codeBrowserBindingHash} is null) or (${table.codeHmac} is not null and ${table.codeExpiresAt} is not null and ${table.codeBrowserBindingHash} is not null)`),
])
export const authRegistrationDeliveries = pgTable('auth_registration_deliveries', {
  id: text('id').primaryKey(), registrationEmailId: text('registration_email_id').notNull().references(() => authRegistrationEmails.id),
  codeVersion: integer('code_version').notNull(), status: text('status').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(), finishedAt: bigint('finished_at', { mode: 'number' }),
}, table => [
  uniqueIndex('auth_registration_deliveries_version_unique').on(table.registrationEmailId, table.codeVersion),
  check('auth_registration_deliveries_version_check', sql`${table.codeVersion} >= 1`),
  check('auth_registration_deliveries_status_check', sql`${table.status} in ('pending', 'sent', 'failed')`),
  check('auth_registration_deliveries_finished_check', sql`(${table.status} = 'pending' and ${table.finishedAt} is null) or (${table.status} <> 'pending' and ${table.finishedAt} is not null)`),
])
export const authRegistrationGrants = pgTable('auth_registration_grants', {
  id: text('id').primaryKey(), tokenHash: text('token_hash').notNull().unique(), browserBindingHash: text('browser_binding_hash').notNull(),
  kind: text('kind').notNull(), email: text('email').notNull(), externalUserId: text('external_user_id'), externalUsername: text('external_username'), providerEmail: text('provider_email'),
  state: text('state').notNull(), expiresAt: bigint('expires_at', { mode: 'number' }).notNull(), createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  consumedAt: bigint('consumed_at', { mode: 'number' }), processingStartedAt: bigint('processing_started_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }), completedUserId: text('completed_user_id').references(() => authUsers.id),
}, table => [
  check('auth_registration_grants_kind_check', sql`(${table.kind} = 'email' and ${table.externalUserId} is null and ${table.externalUsername} is null and ${table.providerEmail} is null) or (${table.kind} = 'cfx' and ${table.externalUserId} is not null and ${table.externalUserId} ~ '^[1-9][0-9]*$' and ${table.externalUsername} is not null and ${table.providerEmail} is not null)`),
  check('auth_registration_grants_state_check', sql`${table.state} in ('active', 'processing', 'completed', 'failed')`),
  check('auth_registration_grants_processing_check', sql`${table.state} <> 'processing' or ${table.processingStartedAt} is not null`),
  check('auth_registration_grants_completed_check', sql`(${table.state} = 'completed' and ${table.completedAt} is not null and ${table.completedUserId} is not null) or (${table.state} <> 'completed' and ${table.completedAt} is null and ${table.completedUserId} is null)`),
  index('auth_registration_grants_expiry_idx').on(table.expiresAt),
])
export const communities = pgTable('communities', {
  id: text('id').primaryKey(), displayName: text('display_name').notNull(), requiresCfx: boolean('requires_cfx').notNull(),
  configRevision: integer('config_revision').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(), updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, table => [
  check('communities_id_check', sql`char_length(${table.id}) between 1 and 64 and ${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check('communities_display_name_check', sql`char_length(${table.displayName}) between 1 and 80`),
  check('communities_revision_check', sql`${table.configRevision} >= 0`),
])
export const communityReviewers = pgTable('community_reviewers', {
  communityId: text('community_id').notNull().references(() => communities.id), userId: text('user_id').notNull().references(() => authUsers.id),
  grantedByUserId: text('granted_by_user_id').notNull().references(() => authUsers.id), grantedAt: bigint('granted_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.communityId, table.userId] })])

export const joinApplications = pgTable('join_applications', {
  id: text('id').primaryKey(), email: text('email').notNull(), nickname: text('nickname').notNull(), qq: text('qq').notNull(),
  status: text('status').notNull(), createdAt: bigint('created_at', { mode: 'number' }).notNull(), reviewedAt: bigint('reviewed_at', { mode: 'number' }),
  reviewedByUserId: text('reviewed_by_user_id').references(() => authUsers.id),
  formVersion: integer('form_version').notNull().default(0),
  communityId: text('community_id').notNull().references(() => communities.id),
  userId: text('user_id').references(() => authUsers.id), legacyReadOnly: boolean('legacy_read_only').notNull().default(false),
  identitySnapshotJson: text('identity_snapshot_json'),
}, table => [
  check('join_applications_form_version_check', sql`${table.formVersion} in (0, 1)`),
  check('join_applications_status_check', sql`${table.status} in ('pending', 'approved', 'rejected')`),
  check('join_applications_review_check', sql`(${table.status} = 'pending' and ${table.reviewedAt} is null) or (${table.status} <> 'pending' and ${table.reviewedAt} is not null)`),
  check('join_applications_owner_check', sql`${table.legacyReadOnly} or ${table.userId} is not null`),
  check('join_applications_reviewer_check', sql`(${table.status} = 'pending' and ${table.reviewedByUserId} is null) or (${table.status} <> 'pending' and (${table.legacyReadOnly} or ${table.reviewedByUserId} is not null))`),
  uniqueIndex('join_applications_user_community_unique').on(table.userId, table.communityId).where(sql`${table.userId} is not null`),
  uniqueIndex('join_applications_identity_unique').on(table.id, table.userId, table.communityId),
  index('join_applications_community_list_idx').on(table.communityId, table.status, table.createdAt, table.id),
  index('join_applications_owner_idx').on(table.userId, table.communityId),
  uniqueIndex('join_applications_id_email_unique').on(table.id, table.email),
  index('join_applications_list_idx').on(table.status, table.createdAt, table.id),
  index('join_applications_email_history_idx').on(table.email, table.createdAt, table.id),
])
export const communityMemberships = pgTable('community_memberships', {
  userId: text('user_id').notNull().references(() => authUsers.id), communityId: text('community_id').notNull().references(() => communities.id),
  applicationId: text('application_id').notNull().unique(), joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.communityId] }),
  foreignKey({ columns: [table.applicationId, table.userId, table.communityId], foreignColumns: [joinApplications.id, joinApplications.userId, joinApplications.communityId], name: 'community_memberships_application_owner_fk' }).onDelete('restrict'),
])
export const joinApplicationEmailRegistry = pgTable('join_application_email_registry', {
  email: text('email').primaryKey().notNull(),
  canonicalApplicationId: text('canonical_application_id').notNull(),
}, table => [foreignKey({ columns: [table.canonicalApplicationId, table.email],
  foreignColumns: [joinApplications.id, joinApplications.email],
  name: 'join_application_email_registry_application_email_fk' }).onDelete('restrict').onUpdate('restrict')])
export const joinApplicationForms = pgTable('join_application_forms', {
  applicationId: text('application_id').primaryKey().notNull().references(() => joinApplications.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  version: integer('version').notNull(), applicationType: text('application_type').notNull(), formJson: text('form_json').notNull(),
}, table => [check('join_application_forms_version_check', sql`${table.version} = 1`),
  check('join_application_forms_type_check', sql`${table.applicationType} in ('new', 'experienced')`)])
export const joinApplicationAttachments = pgTable('join_application_attachments', {
  id: text('id').primaryKey().notNull(),
  applicationId: text('application_id').notNull().references(() => joinApplications.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  ordinal: integer('ordinal').notNull(), originalName: text('original_name').notNull(), extension: text('extension').notNull(),
  sha256: text('sha256').notNull(), byteLength: integer('byte_length').notNull(), bytes: bytea('bytes').notNull(),
}, table => [uniqueIndex('join_application_attachments_ordinal_unique').on(table.applicationId, table.ordinal),
  check('join_application_attachments_ordinal_check', sql`${table.ordinal} between 0 and 4`),
  check('join_application_attachments_length_check', sql`${table.byteLength} between 1 and 10485760 and ${table.byteLength} = octet_length(${table.bytes})`),
  check('join_application_attachments_sha256_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`)])
export const joinInvitations = pgTable('join_invitations', {
  id: text('id').primaryKey(), applicationId: text('application_id').notNull().references(() => joinApplications.id),
  status: text('status').notNull(), issuedAt: bigint('issued_at', { mode: 'number' }).notNull(), expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  codeVersion: integer('code_version').notNull(), codeDigest: text('code_digest'), codeExpiresAt: bigint('code_expires_at', { mode: 'number' }),
  completionTokenHash: text('completion_token_hash'), completionExpiresAt: bigint('completion_expires_at', { mode: 'number' }),
  completedUserId: text('completed_user_id').references(() => authUsers.id), completedAt: bigint('completed_at', { mode: 'number' }),
}, table => [
  check('join_invitations_status_check', sql`${table.status} in ('active', 'expired', 'completed')`),
  check('join_invitations_version_check', sql`${table.codeVersion} >= 1`),
  check('join_invitations_completion_check', sql`(${table.status} = 'completed' and ${table.completedUserId} is not null and ${table.completedAt} is not null) or (${table.status} <> 'completed' and ${table.completedUserId} is null and ${table.completedAt} is null)`),
  uniqueIndex('join_invitations_active_application_unique').on(table.applicationId).where(sql`${table.status} = 'active'`),
  uniqueIndex('join_invitations_completion_token_unique').on(table.completionTokenHash),
  index('join_invitations_application_idx').on(table.applicationId, table.issuedAt, table.id),
  index('join_invitations_expires_idx').on(table.expiresAt),
])
export const joinEmailControls = pgTable('join_email_controls', {
  email: text('email').primaryKey(), nextSendAt: bigint('next_send_at', { mode: 'number' }).notNull(),
  failureWindowStartedAt: bigint('failure_window_started_at', { mode: 'number' }), failedAttempts: integer('failed_attempts').notNull().default(0),
}, table => [check('join_email_controls_failures_check', sql`${table.failedAttempts} between 0 and 5`)])
export const notificationContents = pgTable('notification_contents', {
  contentId: text('content_id').primaryKey(),
  title: text('title').notNull(),
  format: text('format').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  policyVersion: text('policy_version').notNull(),
  html: text('html').notNull(),
  text: text('text').notNull(),
  summaryText: text('summary_text').notNull(),
  contentRevision: integer('content_revision').notNull(),
  templateId: text('template_id').notNull(),
  templateVersion: integer('template_version').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  scope: text('scope').notNull(),
  category: text('category').notNull(),
  necessity: text('necessity').notNull(),
  actionsJson: text('actions_json').notNull(),
  availableAt: bigint('available_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  withdrawnAt: bigint('withdrawn_at', { mode: 'number' }),
  actorUserId: text('actor_user_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, table => [
  foreignKey({ columns: [table.actorUserId], foreignColumns: [authUsers.id],
    name: 'notification_contents_actor_user_id_fk' }).onDelete('restrict'),
  check('notification_contents_format_check', sql`${table.format} = 'html'`),
  check('notification_contents_schema_version_check', sql`${table.schemaVersion} = 1`),
  check('notification_contents_policy_version_check', sql`${table.policyVersion} = 'notification-html-v1'`),
  check('notification_contents_content_revision_check', sql`${table.contentRevision} = 1`),
  check('notification_contents_scope_check', sql`${table.scope} in ('community', 'personal')`),
  check('notification_contents_category_check',
    sql`${table.category} in ('announcement', 'personal_update', 'service_notice')`),
  check('notification_contents_necessity_check', sql`${table.necessity} in ('optional', 'necessary')`),
  check('notification_contents_necessity_category_check',
    sql`(${table.necessity} = 'necessary' and ${table.category} = 'service_notice')
      or (${table.necessity} = 'optional' and ${table.category} in ('announcement', 'personal_update'))`),
  check('notification_contents_template_version_check', sql`${table.templateVersion} >= 1`),
  check('notification_contents_source_revision_check', sql`${table.sourceRevision} >= 1`),
  index('notification_contents_active_idx').on(table.availableAt, table.contentId),
])

export const notificationEvents = pgTable('notification_events', {
  eventId: text('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  eventVersion: integer('event_version').notNull(),
  occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  scope: text('scope').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  digest: text('digest').notNull(),
  actorUserId: text('actor_user_id'),
  dataJson: text('data_json').notNull(),
  contentId: text('content_id'),
  projectionStatus: text('projection_status').notNull(),
  projectionAttempts: integer('projection_attempts').notNull().default(0),
  projectionLeaseOwner: text('projection_lease_owner'),
  projectionLeaseExpiresAt: bigint('projection_lease_expires_at', { mode: 'number' }),
  projectionNextAttemptAt: bigint('projection_next_attempt_at', { mode: 'number' }).notNull(),
  projectionCompletedAt: bigint('projection_completed_at', { mode: 'number' }),
  projectionErrorCode: text('projection_error_code'),
}, table => [
  foreignKey({ columns: [table.actorUserId], foreignColumns: [authUsers.id],
    name: 'notification_events_actor_user_id_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.contentId], foreignColumns: [notificationContents.contentId],
    name: 'notification_events_content_id_fk' }).onDelete('restrict'),
  uniqueIndex('notification_events_dedupe_key_unique').on(table.dedupeKey),
  check('notification_events_event_version_check', sql`${table.eventVersion} = 1`),
  check('notification_events_type_check', sql`${table.eventType} in ('community.announcement.published', 'community.announcement.withdrawn', 'personal.notice.issued', 'join.application.approved', 'join.application.rejected')`),
  check('notification_events_scope_check', sql`${table.scope} in ('community', 'personal')`),
  check('notification_events_status_check', sql`${table.projectionStatus} in ('pending', 'completed', 'failed')`),
  check('notification_events_attempts_check', sql`${table.projectionAttempts} >= 0`),
  check('notification_events_source_revision_check', sql`${table.sourceRevision} >= 1`),
  index('notification_events_due_idx').on(table.projectionStatus, table.projectionNextAttemptAt),
])

export const notificationEventRecipients = pgTable('notification_event_recipients', {
  eventId: text('event_id').notNull(),
  userId: text('user_id').notNull(),
  state: text('state').notNull(),
  decidedAt: bigint('decided_at', { mode: 'number' }),
  receiptId: text('receipt_id'),
}, table => [
  primaryKey({ columns: [table.eventId, table.userId] }),
  foreignKey({ columns: [table.eventId], foreignColumns: [notificationEvents.eventId],
    name: 'notification_event_recipients_event_id_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_event_recipients_user_id_fk' }).onDelete('restrict'),
  check('notification_event_recipients_state_check', sql`${table.state} in ('pending', 'delivered', 'suppressed_preference', 'skipped_disabled', 'expired', 'withdrawn')`),
  check('notification_event_recipients_terminal_check',
    sql`(${table.state} = 'pending' and ${table.decidedAt} is null)
      or (${table.state} <> 'pending' and ${table.decidedAt} is not null)`),
  index('notification_event_recipients_event_state_idx').on(table.eventId, table.state),
  index('notification_event_recipients_user_idx').on(table.userId, table.eventId),
])

export const notificationUserStreams = pgTable('notification_user_streams', {
  userId: text('user_id').primaryKey(),
  lastSequence: integer('last_sequence').notNull().default(0),
  stateVersion: integer('state_version').notNull().default(0),
}, table => [
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_user_streams_user_id_fk' }).onDelete('restrict'),
  check('notification_user_streams_last_sequence_check', sql`${table.lastSequence} >= 0`),
  check('notification_user_streams_state_version_check', sql`${table.stateVersion} >= 0`),
])

export const notificationReceipts = pgTable('notification_receipts', {
  receiptId: text('receipt_id').primaryKey(),
  userId: text('user_id').notNull(),
  contentId: text('content_id').notNull(),
  eventId: text('event_id').notNull(),
  sequence: integer('sequence').notNull(),
  scope: text('scope').notNull(),
  deliveredAt: bigint('delivered_at', { mode: 'number' }).notNull(),
  readAt: bigint('read_at', { mode: 'number' }),
  clearedAt: bigint('cleared_at', { mode: 'number' }),
  clearBatchId: text('clear_batch_id'),
  clearRevision: integer('clear_revision').notNull().default(0),
  stateRevision: integer('state_revision').notNull().default(0),
}, table => [
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_receipts_user_id_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.contentId], foreignColumns: [notificationContents.contentId],
    name: 'notification_receipts_content_id_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.eventId], foreignColumns: [notificationEvents.eventId],
    name: 'notification_receipts_event_id_fk' }).onDelete('restrict'),
  uniqueIndex('notification_receipts_content_user_unique').on(table.contentId, table.userId),
  uniqueIndex('notification_receipts_user_sequence_unique').on(table.userId, table.sequence),
  check('notification_receipts_scope_check', sql`${table.scope} in ('community', 'personal')`),
  check('notification_receipts_sequence_check', sql`${table.sequence} >= 1`),
  check('notification_receipts_clear_revision_check', sql`${table.clearRevision} >= 0`),
  check('notification_receipts_state_revision_check', sql`${table.stateRevision} >= 0`),
  check('notification_receipts_clear_batch_check',
    sql`(${table.clearedAt} is null and ${table.clearBatchId} is null)
      or (${table.clearedAt} is not null and ${table.clearBatchId} is not null)`),
  index('notification_receipts_history_idx').on(table.userId, sql`${table.sequence} DESC`),
  index('notification_receipts_unread_idx').on(table.userId, sql`${table.sequence} DESC`)
    .where(sql`${table.clearedAt} is null and ${table.readAt} is null`),
])

export const notificationPreferences = pgTable('notification_preferences', {
  userId: text('user_id').primaryKey(),
  announcementEnabled: boolean('announcement_enabled').notNull(),
  personalUpdateEnabled: boolean('personal_update_enabled').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, table => [
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_preferences_user_id_fk' }).onDelete('restrict'),
  check('notification_preferences_revision_check', sql`${table.revision} >= 0`),
])

export const notificationMutations = pgTable('notification_mutations', {
  userId: text('user_id').notNull(),
  requestId: text('request_id').notNull(),
  kind: text('kind').notNull(),
  digest: text('digest').notNull(),
  resultJson: text('result_json').notNull(),
  clearBatchId: text('clear_batch_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.requestId] }),
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_mutations_user_id_fk' }).onDelete('restrict'),
  check('notification_mutations_kind_check', sql`${table.kind} in ('read_through', 'clear', 'restore')`),
  index('notification_mutations_user_kind_idx').on(table.userId, table.kind, table.createdAt),
])

export const notificationClearBatches = pgTable('notification_clear_batches', {
  batchId: text('batch_id').primaryKey(),
  userId: text('user_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  upperSequence: integer('upper_sequence').notNull(),
  previewExpiresAt: bigint('preview_expires_at', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  requestId: text('request_id'),
  itemCount: integer('item_count').notNull(),
  affectedCount: integer('affected_count'),
  skippedCount: integer('skipped_count'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  appliedAt: bigint('applied_at', { mode: 'number' }),
  restoredAt: bigint('restored_at', { mode: 'number' }),
}, table => [
  foreignKey({ columns: [table.userId], foreignColumns: [authUsers.id],
    name: 'notification_clear_batches_user_id_fk' }).onDelete('restrict'),
  check('notification_clear_batches_status_check', sql`${table.status} in ('preview', 'applied', 'restored')`),
  check('notification_clear_batches_upper_sequence_check', sql`${table.upperSequence} >= 0`),
  check('notification_clear_batches_item_count_check', sql`${table.itemCount} >= 0`),
  check('notification_clear_batches_applied_check',
    sql`(${table.status} = 'preview' and ${table.appliedAt} is null)
      or (${table.status} <> 'preview' and ${table.appliedAt} is not null)`),
  check('notification_clear_batches_restored_check',
    sql`(${table.status} = 'restored' and ${table.restoredAt} is not null)
      or (${table.status} <> 'restored' and ${table.restoredAt} is null)`),
  check('notification_clear_batches_counts_check',
    sql`(${table.affectedCount} is null and ${table.skippedCount} is null and ${table.requestId} is null)
      or (${table.affectedCount} is not null and ${table.skippedCount} is not null and ${table.requestId} is not null)`),
  index('notification_clear_batches_user_idx').on(table.userId, sql`${table.createdAt} DESC`, table.batchId),
])

export const notificationClearBatchItems = pgTable('notification_clear_batch_items', {
  batchId: text('batch_id').notNull(),
  receiptId: text('receipt_id').notNull(),
  expectedClearRevision: integer('expected_clear_revision').notNull(),
  appliedClearRevision: integer('applied_clear_revision'),
}, table => [
  primaryKey({ columns: [table.batchId, table.receiptId] }),
  foreignKey({ columns: [table.batchId], foreignColumns: [notificationClearBatches.batchId],
    name: 'notification_clear_batch_items_batch_id_fk' }).onDelete('restrict'),
  foreignKey({ columns: [table.receiptId], foreignColumns: [notificationReceipts.receiptId],
    name: 'notification_clear_batch_items_receipt_id_fk' }).onDelete('restrict'),
  check('notification_clear_batch_items_expected_revision_check', sql`${table.expectedClearRevision} >= 0`),
  check('notification_clear_batch_items_applied_revision_check',
    sql`${table.appliedClearRevision} is null or ${table.appliedClearRevision} >= 0`),
  index('notification_clear_batch_items_receipt_idx').on(table.receiptId),
])

export const joinDeliveryAttempts = pgTable('join_delivery_attempts', {
  id: text('id').primaryKey(), invitationId: text('invitation_id').notNull().references(() => joinInvitations.id),
  codeVersion: integer('code_version').notNull(), startedAt: bigint('started_at', { mode: 'number' }).notNull(), finishedAt: bigint('finished_at', { mode: 'number' }), status: text('status').notNull(),
}, table => [
  uniqueIndex('join_delivery_attempts_version_unique').on(table.invitationId, table.codeVersion),
  check('join_delivery_attempts_status_check', sql`${table.status} in ('pending', 'sent', 'failed')`),
  check('join_delivery_attempts_finished_check', sql`(${table.status} = 'pending' and ${table.finishedAt} is null) or (${table.status} <> 'pending' and ${table.finishedAt} is not null)`),
])
