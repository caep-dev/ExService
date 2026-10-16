import type { SqlExecutor } from '@server/src/db/client.js'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as schemaTables from '@server/src/db/schema.js'
import { SUPPORT_CONSTRAINT_DEFINITIONS, SUPPORT_INDEX_SIGNATURES } from './support-signatures.js'

const tableDefinitions = [
  schemaTables.authIdentityLinks, schemaTables.authRegistrationEmails, schemaTables.authRegistrationDeliveries,
  schemaTables.authRegistrationGrants, schemaTables.communities, schemaTables.communityReviewers, schemaTables.communityMemberships,
  schemaTables.authUsers, schemaTables.authSessions, schemaTables.authSsoRequests,
  schemaTables.authOidcFlows, schemaTables.authOidcBindings, schemaTables.authIdentityOutbox,
  schemaTables.communityGroups, schemaTables.communityGroupMemberships,
  schemaTables.joinApplications, schemaTables.joinApplicationEmailRegistry,
  schemaTables.joinApplicationForms, schemaTables.joinApplicationAttachments,
  schemaTables.joinInvitations, schemaTables.joinEmailControls, schemaTables.joinDeliveryAttempts,
  schemaTables.notificationContents, schemaTables.notificationEvents,
  schemaTables.notificationEventRecipients, schemaTables.notificationUserStreams,
  schemaTables.notificationReceipts, schemaTables.notificationPreferences,
  schemaTables.notificationMutations, schemaTables.notificationClearBatches,
  schemaTables.notificationClearBatchItems,
  schemaTables.supportFeedbackSubmissions, schemaTables.supportFeedbackAttachments,
].map(getTableConfig)

// PostgreSQL's stock NAMEDATALEN allows 63 bytes per identifier. Generated
// foreign-key names can exceed that limit; the catalog stores the truncated name.
const catalogName = (name: string) => Buffer.from(name, 'utf8').subarray(0, 63).toString('utf8')

export const NOTIFICATION_APPLICATION_TABLES = [
  'auth_users', 'auth_sessions', 'auth_sso_requests', 'community_groups',
  'community_group_memberships', 'join_applications', 'join_application_email_registry',
  'join_application_forms', 'join_application_attachments', 'join_invitations',
  'join_email_controls', 'join_delivery_attempts',
  'auth_oidc_flows', 'auth_oidc_bindings', 'auth_identity_outbox',
  'notification_contents', 'notification_events', 'notification_event_recipients',
  'notification_user_streams', 'notification_receipts', 'notification_preferences',
  'notification_mutations', 'notification_clear_batches', 'notification_clear_batch_items',
] as const

export const SUPPORT_APPLICATION_TABLES = [...NOTIFICATION_APPLICATION_TABLES,
  'support_feedback_submissions', 'support_feedback_attachments'] as const

export const APPLICATION_TABLES = [...SUPPORT_APPLICATION_TABLES, 'auth_identity_links', 'auth_registration_emails', 'auth_registration_deliveries', 'auth_registration_grants', 'communities', 'community_reviewers', 'community_memberships'] as const
export const BASELINE_APPLICATION_TABLES = NOTIFICATION_APPLICATION_TABLES.slice(0, 12)

const expectedIndexes = tableDefinitions.flatMap(table => [
  ...table.indexes.map(index => index.config.name)
    .filter((name): name is string => name !== undefined),
  ...table.columns.filter(column => column.primary).map(() => `${table.name}_pkey`),
  ...table.columns.filter(column => column.isUnique).map(column => column.uniqueName)
    .filter((name): name is string => name !== undefined),
  ...table.primaryKeys.map(key => `${table.name}_${key.columns.map(column => column.name).join('_')}_pk`),
].map(name => `${table.name}.${catalogName(name)}`))

const expectedConstraints = tableDefinitions.flatMap(table => [
  ...table.foreignKeys.map(key => key.getName()),
  ...table.checks.map(check => check.name),
  ...table.columns.filter(column => column.primary).map(() => `${table.name}_pkey`),
  ...table.columns.filter(column => column.isUnique).map(column => column.uniqueName)
    .filter((name): name is string => name !== undefined),
  ...table.primaryKeys.map(key => `${table.name}_${key.columns.map(column => column.name).join('_')}_pk`),
].map(name => `${table.name}.${catalogName(name)}`))

// Canonical PostgreSQL deparse signatures from the approved baseline migration.
// Names alone do not prove an index or constraint still enforces the same rule.
export const BASELINE_CONSTRAINT_DEFINITIONS = new Map<string, string>([
  ["auth_sessions.auth_sessions_pkey", "PRIMARY KEY (token_hash)"],
  ["auth_sessions.auth_sessions_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["auth_sso_requests.auth_sso_requests_pkey", "PRIMARY KEY (id_hash)"],
  ["auth_sso_requests.auth_sso_requests_status_check", "CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text]))"],
  ["auth_sso_requests.auth_sso_requests_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["auth_users.auth_users_email_unique", "UNIQUE (email)"],
  ["auth_users.auth_users_pkey", "PRIMARY KEY (id)"],
  ["community_group_memberships.community_group_memberships_group_code_community_groups_code_fk", "FOREIGN KEY (group_code) REFERENCES community_groups(code)"],
  ["community_group_memberships.community_group_memberships_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["community_group_memberships.community_group_memberships_user_id_group_code_pk", "PRIMARY KEY (user_id, group_code)"],
  ["community_groups.community_groups_pkey", "PRIMARY KEY (code)"],
  ["join_application_attachments.join_application_attachments_application_id_join_applications_i", "FOREIGN KEY (application_id) REFERENCES join_applications(id) ON UPDATE RESTRICT ON DELETE RESTRICT"],
  ["join_application_attachments.join_application_attachments_length_check", "CHECK (byte_length >= 1 AND byte_length <= 10485760 AND byte_length = octet_length(bytes))"],
  ["join_application_attachments.join_application_attachments_ordinal_check", "CHECK (ordinal >= 0 AND ordinal <= 4)"],
  ["join_application_attachments.join_application_attachments_pkey", "PRIMARY KEY (id)"],
  ["join_application_attachments.join_application_attachments_sha256_check", "CHECK (sha256 ~ '^[0-9a-f]{64}$'::text)"],
  ["join_application_email_registry.join_application_email_registry_application_email_fk", "FOREIGN KEY (canonical_application_id, email) REFERENCES join_applications(id, email) ON UPDATE RESTRICT ON DELETE RESTRICT"],
  ["join_application_email_registry.join_application_email_registry_pkey", "PRIMARY KEY (email)"],
  ["join_application_forms.join_application_forms_application_id_join_applications_id_fk", "FOREIGN KEY (application_id) REFERENCES join_applications(id) ON UPDATE RESTRICT ON DELETE RESTRICT"],
  ["join_application_forms.join_application_forms_pkey", "PRIMARY KEY (application_id)"],
  ["join_application_forms.join_application_forms_type_check", "CHECK (application_type = ANY (ARRAY['new'::text, 'experienced'::text]))"],
  ["join_application_forms.join_application_forms_version_check", "CHECK (version = 1)"],
  ["join_applications.join_applications_form_version_check", "CHECK (form_version = ANY (ARRAY[0, 1]))"],
  ["join_applications.join_applications_pkey", "PRIMARY KEY (id)"],
  ["join_applications.join_applications_review_check", "CHECK (status = 'pending'::text AND reviewed_at IS NULL OR status <> 'pending'::text AND reviewed_at IS NOT NULL)"],
  ["join_applications.join_applications_reviewed_by_user_id_auth_users_id_fk", "FOREIGN KEY (reviewed_by_user_id) REFERENCES auth_users(id)"],
  ["join_applications.join_applications_status_check", "CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))"],
  ["join_delivery_attempts.join_delivery_attempts_finished_check", "CHECK (status = 'pending'::text AND finished_at IS NULL OR status <> 'pending'::text AND finished_at IS NOT NULL)"],
  ["join_delivery_attempts.join_delivery_attempts_invitation_id_join_invitations_id_fk", "FOREIGN KEY (invitation_id) REFERENCES join_invitations(id)"],
  ["join_delivery_attempts.join_delivery_attempts_pkey", "PRIMARY KEY (id)"],
  ["join_delivery_attempts.join_delivery_attempts_status_check", "CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))"],
  ["join_email_controls.join_email_controls_failures_check", "CHECK (failed_attempts >= 0 AND failed_attempts <= 5)"],
  ["join_email_controls.join_email_controls_pkey", "PRIMARY KEY (email)"],
  ["join_invitations.join_invitations_application_id_join_applications_id_fk", "FOREIGN KEY (application_id) REFERENCES join_applications(id)"],
  ["join_invitations.join_invitations_completed_user_id_auth_users_id_fk", "FOREIGN KEY (completed_user_id) REFERENCES auth_users(id)"],
  ["join_invitations.join_invitations_completion_check", "CHECK (status = 'completed'::text AND completed_user_id IS NOT NULL AND completed_at IS NOT NULL OR status <> 'completed'::text AND completed_user_id IS NULL AND completed_at IS NULL)"],
  ["join_invitations.join_invitations_pkey", "PRIMARY KEY (id)"],
  ["join_invitations.join_invitations_status_check", "CHECK (status = ANY (ARRAY['active'::text, 'expired'::text, 'completed'::text]))"],
  ["join_invitations.join_invitations_version_check", "CHECK (code_version >= 1)"],
])

// The signature omits only the index name and qualified table, which are checked
// separately. It retains uniqueness, access method, columns and any predicate.
export const BASELINE_INDEX_SIGNATURES = new Map<string, string>([
  ["auth_sessions.auth_sessions_expires_at_idx", "btree (expires_at)"],
  ["auth_sessions.auth_sessions_pkey", "UNIQUE btree (token_hash)"],
  ["auth_sessions.auth_sessions_user_id_idx", "btree (user_id)"],
  ["auth_sso_requests.auth_sso_requests_expires_at_idx", "btree (expires_at)"],
  ["auth_sso_requests.auth_sso_requests_pkey", "UNIQUE btree (id_hash)"],
  ["auth_users.auth_users_avatar_key_unique", "UNIQUE btree (avatar_key)"],
  ["auth_users.auth_users_email_unique", "UNIQUE btree (email)"],
  ["auth_users.auth_users_pkey", "UNIQUE btree (id)"],
  ["community_group_memberships.community_group_memberships_user_id_group_code_pk", "UNIQUE btree (user_id, group_code)"],
  ["community_groups.community_groups_pkey", "UNIQUE btree (code)"],
  ["join_application_attachments.join_application_attachments_ordinal_unique", "UNIQUE btree (application_id, ordinal)"],
  ["join_application_attachments.join_application_attachments_pkey", "UNIQUE btree (id)"],
  ["join_application_email_registry.join_application_email_registry_pkey", "UNIQUE btree (email)"],
  ["join_application_forms.join_application_forms_pkey", "UNIQUE btree (application_id)"],
  ["join_applications.join_applications_email_history_idx", "btree (email, created_at, id)"],
  ["join_applications.join_applications_id_email_unique", "UNIQUE btree (id, email)"],
  ["join_applications.join_applications_list_idx", "btree (status, created_at, id)"],
  ["join_applications.join_applications_open_email_unique", "UNIQUE btree (email) WHERE (status = ANY (ARRAY['pending'::text, 'approved'::text]))"],
  ["join_applications.join_applications_pkey", "UNIQUE btree (id)"],
  ["join_delivery_attempts.join_delivery_attempts_pkey", "UNIQUE btree (id)"],
  ["join_delivery_attempts.join_delivery_attempts_version_unique", "UNIQUE btree (invitation_id, code_version)"],
  ["join_email_controls.join_email_controls_pkey", "UNIQUE btree (email)"],
  ["join_invitations.join_invitations_active_application_unique", "UNIQUE btree (application_id) WHERE (status = 'active'::text)"],
  ["join_invitations.join_invitations_application_idx", "btree (application_id, issued_at, id)"],
  ["join_invitations.join_invitations_completion_token_unique", "UNIQUE btree (completion_token_hash)"],
  ["join_invitations.join_invitations_expires_idx", "btree (expires_at)"],
  ["join_invitations.join_invitations_pkey", "UNIQUE btree (id)"],
])

export const APPLICATION_CONSTRAINT_DEFINITIONS = new Map<string, string>([
  ...SUPPORT_CONSTRAINT_DEFINITIONS,
  ...BASELINE_CONSTRAINT_DEFINITIONS,
  ['auth_identity_outbox.auth_identity_outbox_pkey', 'PRIMARY KEY (event_id)'],
  ['auth_identity_outbox.auth_identity_outbox_kind_check', "CHECK (kind = ANY (ARRAY['session'::text, 'user'::text]))"],
  ['auth_identity_outbox.auth_identity_outbox_attempts_check', 'CHECK (attempts >= 0)'],
  ['auth_identity_outbox.auth_identity_outbox_session_id_auth_sessions_id_fk', 'FOREIGN KEY (session_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT'],
  ['auth_identity_outbox.auth_identity_outbox_user_id_auth_users_id_fk', 'FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT'],
  ['auth_oidc_bindings.auth_oidc_bindings_client_id_hydra_sid_pk', 'PRIMARY KEY (client_id, hydra_sid)'],
  ['auth_oidc_bindings.auth_oidc_bindings_session_owner_fk', 'FOREIGN KEY (session_id, user_id) REFERENCES auth_sessions(id, user_id) ON DELETE RESTRICT'],
  ['auth_oidc_flows.auth_oidc_flows_phase_challenge_hash_pk', 'PRIMARY KEY (phase, challenge_hash)'],
  ['auth_oidc_flows.auth_oidc_flows_phase_check', "CHECK (phase = ANY (ARRAY['login'::text, 'consent'::text]))"],
  ['auth_oidc_flows.auth_oidc_flows_state_check', "CHECK (state = ANY (ARRAY['processing'::text, 'completed'::text, 'restart_required'::text]))"],
  ['auth_oidc_flows.auth_oidc_flows_session_id_auth_sessions_id_fk', 'FOREIGN KEY (session_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT'],
  ['auth_users.auth_users_profile_version_check', 'CHECK (profile_version >= 0)'],
  ['notification_clear_batch_items.notification_clear_batch_items_applied_revision_check', "CHECK (applied_clear_revision IS NULL OR applied_clear_revision >= 0)"],
  ['notification_clear_batch_items.notification_clear_batch_items_batch_id_fk', "FOREIGN KEY (batch_id) REFERENCES notification_clear_batches(batch_id) ON DELETE RESTRICT"],
  ['notification_clear_batch_items.notification_clear_batch_items_batch_id_receipt_id_pk', "PRIMARY KEY (batch_id, receipt_id)"],
  ['notification_clear_batch_items.notification_clear_batch_items_expected_revision_check', "CHECK (expected_clear_revision >= 0)"],
  ['notification_clear_batch_items.notification_clear_batch_items_receipt_id_fk', "FOREIGN KEY (receipt_id) REFERENCES notification_receipts(receipt_id) ON DELETE RESTRICT"],
  ['notification_clear_batches.notification_clear_batches_applied_check', "CHECK (status = 'preview'::text AND applied_at IS NULL OR status <> 'preview'::text AND applied_at IS NOT NULL)"],
  ['notification_clear_batches.notification_clear_batches_counts_check', "CHECK (affected_count IS NULL AND skipped_count IS NULL AND request_id IS NULL OR affected_count IS NOT NULL AND skipped_count IS NOT NULL AND request_id IS NOT NULL)"],
  ['notification_clear_batches.notification_clear_batches_item_count_check', "CHECK (item_count >= 0)"],
  ['notification_clear_batches.notification_clear_batches_pkey', "PRIMARY KEY (batch_id)"],
  ['notification_clear_batches.notification_clear_batches_restored_check', "CHECK (status = 'restored'::text AND restored_at IS NOT NULL OR status <> 'restored'::text AND restored_at IS NULL)"],
  ['notification_clear_batches.notification_clear_batches_status_check', "CHECK (status = ANY (ARRAY['preview'::text, 'applied'::text, 'restored'::text]))"],
  ['notification_clear_batches.notification_clear_batches_upper_sequence_check', "CHECK (upper_sequence >= 0)"],
  ['notification_clear_batches.notification_clear_batches_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_contents.notification_contents_actor_user_id_fk', "FOREIGN KEY (actor_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_contents.notification_contents_category_check', "CHECK (category = ANY (ARRAY['announcement'::text, 'personal_update'::text, 'service_notice'::text]))"],
  ['notification_contents.notification_contents_content_revision_check', "CHECK (content_revision = 1)"],
  ['notification_contents.notification_contents_format_check', "CHECK (format = 'html'::text)"],
  ['notification_contents.notification_contents_necessity_category_check', "CHECK (necessity = 'necessary'::text AND category = 'service_notice'::text OR necessity = 'optional'::text AND (category = ANY (ARRAY['announcement'::text, 'personal_update'::text])))"],
  ['notification_contents.notification_contents_necessity_check', "CHECK (necessity = ANY (ARRAY['optional'::text, 'necessary'::text]))"],
  ['notification_contents.notification_contents_pkey', "PRIMARY KEY (content_id)"],
  ['notification_contents.notification_contents_policy_version_check', "CHECK (policy_version = 'notification-html-v1'::text)"],
  ['notification_contents.notification_contents_schema_version_check', "CHECK (schema_version = 1)"],
  ['notification_contents.notification_contents_scope_check', "CHECK (scope = ANY (ARRAY['community'::text, 'personal'::text]))"],
  ['notification_contents.notification_contents_source_revision_check', "CHECK (source_revision >= 1)"],
  ['notification_contents.notification_contents_template_version_check', "CHECK (template_version >= 1)"],
  ['notification_event_recipients.notification_event_recipients_event_id_fk', "FOREIGN KEY (event_id) REFERENCES notification_events(event_id) ON DELETE RESTRICT"],
  ['notification_event_recipients.notification_event_recipients_event_id_user_id_pk', "PRIMARY KEY (event_id, user_id)"],
  ['notification_event_recipients.notification_event_recipients_state_check', "CHECK (state = ANY (ARRAY['pending'::text, 'delivered'::text, 'suppressed_preference'::text, 'skipped_disabled'::text, 'expired'::text, 'withdrawn'::text]))"],
  ['notification_event_recipients.notification_event_recipients_terminal_check', "CHECK (state = 'pending'::text AND decided_at IS NULL OR state <> 'pending'::text AND decided_at IS NOT NULL)"],
  ['notification_event_recipients.notification_event_recipients_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_events.notification_events_actor_user_id_fk', "FOREIGN KEY (actor_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_events.notification_events_attempts_check', "CHECK (projection_attempts >= 0)"],
  ['notification_events.notification_events_content_id_fk', "FOREIGN KEY (content_id) REFERENCES notification_contents(content_id) ON DELETE RESTRICT"],
  ['notification_events.notification_events_event_version_check', "CHECK (event_version = 1)"],
  ['notification_events.notification_events_pkey', "PRIMARY KEY (event_id)"],
  ['notification_events.notification_events_scope_check', "CHECK (scope = ANY (ARRAY['community'::text, 'personal'::text]))"],
  ['notification_events.notification_events_source_revision_check', "CHECK (source_revision >= 1)"],
  ['notification_events.notification_events_status_check', "CHECK (projection_status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text]))"],
  ['notification_events.notification_events_type_check', "CHECK (event_type = ANY (ARRAY['community.announcement.published'::text, 'community.announcement.withdrawn'::text, 'personal.notice.issued'::text, 'join.application.approved'::text, 'join.application.rejected'::text]))"],
  ['notification_mutations.notification_mutations_kind_check', "CHECK (kind = ANY (ARRAY['read_through'::text, 'clear'::text, 'restore'::text]))"],
  ['notification_mutations.notification_mutations_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_mutations.notification_mutations_user_id_request_id_pk', "PRIMARY KEY (user_id, request_id)"],
  ['notification_preferences.notification_preferences_pkey', "PRIMARY KEY (user_id)"],
  ['notification_preferences.notification_preferences_revision_check', "CHECK (revision >= 0)"],
  ['notification_preferences.notification_preferences_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_receipts.notification_receipts_clear_batch_check', "CHECK (cleared_at IS NULL AND clear_batch_id IS NULL OR cleared_at IS NOT NULL AND clear_batch_id IS NOT NULL)"],
  ['notification_receipts.notification_receipts_clear_revision_check', "CHECK (clear_revision >= 0)"],
  ['notification_receipts.notification_receipts_content_id_fk', "FOREIGN KEY (content_id) REFERENCES notification_contents(content_id) ON DELETE RESTRICT"],
  ['notification_receipts.notification_receipts_event_id_fk', "FOREIGN KEY (event_id) REFERENCES notification_events(event_id) ON DELETE RESTRICT"],
  ['notification_receipts.notification_receipts_pkey', "PRIMARY KEY (receipt_id)"],
  ['notification_receipts.notification_receipts_scope_check', "CHECK (scope = ANY (ARRAY['community'::text, 'personal'::text]))"],
  ['notification_receipts.notification_receipts_sequence_check', "CHECK (sequence >= 1)"],
  ['notification_receipts.notification_receipts_state_revision_check', "CHECK (state_revision >= 0)"],
  ['notification_receipts.notification_receipts_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
  ['notification_user_streams.notification_user_streams_last_sequence_check', "CHECK (last_sequence >= 0)"],
  ['notification_user_streams.notification_user_streams_pkey', "PRIMARY KEY (user_id)"],
  ['notification_user_streams.notification_user_streams_state_version_check', "CHECK (state_version >= 0)"],
  ['notification_user_streams.notification_user_streams_user_id_fk', "FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE RESTRICT"],
])

export const APPLICATION_INDEX_SIGNATURES = new Map<string, string>([
  ...SUPPORT_INDEX_SIGNATURES,
  ...BASELINE_INDEX_SIGNATURES,
  ['auth_identity_outbox.auth_identity_outbox_pkey', 'UNIQUE btree (event_id)'],
  ['auth_identity_outbox.auth_identity_outbox_due_idx', 'btree (completed_at, next_attempt_at)'],
  ['auth_oidc_bindings.auth_oidc_bindings_client_id_hydra_sid_pk', 'UNIQUE btree (client_id, hydra_sid)'],
  ['auth_oidc_bindings.auth_oidc_bindings_session_idx', 'btree (session_id)'],
  ['auth_oidc_bindings.auth_oidc_bindings_user_idx', 'btree (user_id)'],
  ['auth_oidc_flows.auth_oidc_flows_phase_challenge_hash_pk', 'UNIQUE btree (phase, challenge_hash)'],
  ['auth_oidc_flows.auth_oidc_flows_expires_at_idx', 'btree (expires_at)'],
  ['auth_sessions.auth_sessions_id_unique', 'UNIQUE btree (id)'],
  ['auth_sessions.auth_sessions_id_user_id_unique', 'UNIQUE btree (id, user_id)'],
  ['notification_clear_batch_items.notification_clear_batch_items_batch_id_receipt_id_pk', "UNIQUE btree (batch_id, receipt_id)"],
  ['notification_clear_batch_items.notification_clear_batch_items_receipt_idx', "btree (receipt_id)"],
  ['notification_clear_batches.notification_clear_batches_pkey', "UNIQUE btree (batch_id)"],
  ['notification_clear_batches.notification_clear_batches_user_idx', "btree (user_id, created_at DESC, batch_id)"],
  ['notification_contents.notification_contents_active_idx', "btree (available_at, content_id)"],
  ['notification_contents.notification_contents_pkey', "UNIQUE btree (content_id)"],
  ['notification_event_recipients.notification_event_recipients_event_id_user_id_pk', "UNIQUE btree (event_id, user_id)"],
  ['notification_event_recipients.notification_event_recipients_event_state_idx', "btree (event_id, state)"],
  ['notification_event_recipients.notification_event_recipients_user_idx', "btree (user_id, event_id)"],
  ['notification_events.notification_events_dedupe_key_unique', "UNIQUE btree (dedupe_key)"],
  ['notification_events.notification_events_due_idx', "btree (projection_status, projection_next_attempt_at)"],
  ['notification_events.notification_events_pkey', "UNIQUE btree (event_id)"],
  ['notification_mutations.notification_mutations_user_id_request_id_pk', "UNIQUE btree (user_id, request_id)"],
  ['notification_mutations.notification_mutations_user_kind_idx', "btree (user_id, kind, created_at)"],
  ['notification_preferences.notification_preferences_pkey', "UNIQUE btree (user_id)"],
  ['notification_receipts.notification_receipts_content_user_unique', "UNIQUE btree (content_id, user_id)"],
  ['notification_receipts.notification_receipts_history_idx', "btree (user_id, sequence DESC)"],
  ['notification_receipts.notification_receipts_pkey', "UNIQUE btree (receipt_id)"],
  ['notification_receipts.notification_receipts_unread_idx', "btree (user_id, sequence DESC) WHERE ((cleared_at IS NULL) AND (read_at IS NULL))"],
  ['notification_receipts.notification_receipts_user_sequence_unique', "UNIQUE btree (user_id, sequence)"],
  ['notification_user_streams.notification_user_streams_pkey', "UNIQUE btree (user_id)"],
])

// PostgreSQL catalog definitions verified against migration 0003 in isolated PG18.
for (const [name, definition] of [
  ["auth_identity_links.auth_identity_links_provider_check", "CHECK (provider = 'cfx'::text)"],
  ["auth_identity_links.auth_identity_links_subject_check", "CHECK (external_user_id ~ '^[1-9][0-9]*$'::text)"],
  ["auth_identity_links.auth_identity_links_pkey", "PRIMARY KEY (id)"],
  ["auth_registration_deliveries.auth_registration_deliveries_version_check", "CHECK (code_version >= 1)"],
  ["auth_registration_deliveries.auth_registration_deliveries_status_check", "CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))"],
  ["auth_registration_deliveries.auth_registration_deliveries_finished_check", "CHECK (status = 'pending'::text AND finished_at IS NULL OR status <> 'pending'::text AND finished_at IS NOT NULL)"],
  ["auth_registration_deliveries.auth_registration_deliveries_pkey", "PRIMARY KEY (id)"],
  ["auth_registration_emails.auth_registration_emails_version_check", "CHECK (code_version >= 0)"],
  ["auth_registration_emails.auth_registration_emails_failures_check", "CHECK (failed_attempts >= 0 AND failed_attempts <= 5)"],
  ["auth_registration_emails.auth_registration_emails_material_check", "CHECK (code_hmac IS NULL AND code_expires_at IS NULL AND code_browser_binding_hash IS NULL OR code_hmac IS NOT NULL AND code_expires_at IS NOT NULL AND code_browser_binding_hash IS NOT NULL)"],
  ["auth_registration_emails.auth_registration_emails_pkey", "PRIMARY KEY (id)"],
  ["auth_registration_emails.auth_registration_emails_email_unique", "UNIQUE (email)"],
  ["auth_registration_grants.auth_registration_grants_kind_check", "CHECK (kind = 'email'::text AND external_user_id IS NULL AND external_username IS NULL AND provider_email IS NULL OR kind = 'cfx'::text AND external_user_id IS NOT NULL AND external_user_id ~ '^[1-9][0-9]*$'::text AND external_username IS NOT NULL AND provider_email IS NOT NULL)"],
  ["auth_registration_grants.auth_registration_grants_state_check", "CHECK (state = ANY (ARRAY['active'::text, 'processing'::text, 'completed'::text, 'failed'::text]))"],
  ["auth_registration_grants.auth_registration_grants_processing_check", "CHECK (state <> 'processing'::text OR processing_started_at IS NOT NULL)"],
  ["auth_registration_grants.auth_registration_grants_completed_check", "CHECK (state = 'completed'::text AND completed_at IS NOT NULL AND completed_user_id IS NOT NULL OR state <> 'completed'::text AND completed_at IS NULL AND completed_user_id IS NULL)"],
  ["auth_registration_grants.auth_registration_grants_pkey", "PRIMARY KEY (id)"],
  ["auth_registration_grants.auth_registration_grants_token_hash_unique", "UNIQUE (token_hash)"],
  ["communities.communities_id_check", "CHECK (char_length(id) >= 1 AND char_length(id) <= 64 AND id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)"],
  ["communities.communities_display_name_check", "CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 80)"],
  ["communities.communities_revision_check", "CHECK (config_revision >= 0)"],
  ["communities.communities_pkey", "PRIMARY KEY (id)"],
  ["community_memberships.community_memberships_user_id_community_id_pk", "PRIMARY KEY (user_id, community_id)"],
  ["community_memberships.community_memberships_application_id_unique", "UNIQUE (application_id)"],
  ["community_reviewers.community_reviewers_community_id_user_id_pk", "PRIMARY KEY (community_id, user_id)"],
  ["auth_identity_links.auth_identity_links_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["auth_registration_deliveries.auth_registration_deliveries_registration_email_id_auth_registr", "FOREIGN KEY (registration_email_id) REFERENCES auth_registration_emails(id)"],
  ["auth_registration_grants.auth_registration_grants_completed_user_id_auth_users_id_fk", "FOREIGN KEY (completed_user_id) REFERENCES auth_users(id)"],
  ["community_memberships.community_memberships_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["community_memberships.community_memberships_community_id_communities_id_fk", "FOREIGN KEY (community_id) REFERENCES communities(id)"],
  ["community_reviewers.community_reviewers_community_id_communities_id_fk", "FOREIGN KEY (community_id) REFERENCES communities(id)"],
  ["community_reviewers.community_reviewers_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["community_reviewers.community_reviewers_granted_by_user_id_auth_users_id_fk", "FOREIGN KEY (granted_by_user_id) REFERENCES auth_users(id)"],
  ["join_applications.join_applications_community_id_communities_id_fk", "FOREIGN KEY (community_id) REFERENCES communities(id)"],
  ["join_applications.join_applications_user_id_auth_users_id_fk", "FOREIGN KEY (user_id) REFERENCES auth_users(id)"],
  ["join_applications.join_applications_owner_check", "CHECK (legacy_read_only OR user_id IS NOT NULL)"],
  ["join_applications.join_applications_reviewer_check", "CHECK (status = 'pending'::text AND reviewed_by_user_id IS NULL OR status <> 'pending'::text AND (legacy_read_only OR reviewed_by_user_id IS NOT NULL))"],
  ["community_memberships.community_memberships_application_owner_fk", "FOREIGN KEY (application_id, user_id, community_id) REFERENCES join_applications(id, user_id, community_id) ON DELETE RESTRICT"]
] as const) APPLICATION_CONSTRAINT_DEFINITIONS.set(name, definition)
for (const [name, definition] of [
  ["auth_identity_links.auth_identity_links_pkey", "UNIQUE btree (id)"],
  ["auth_registration_deliveries.auth_registration_deliveries_pkey", "UNIQUE btree (id)"],
  ["auth_registration_emails.auth_registration_emails_pkey", "UNIQUE btree (id)"],
  ["auth_registration_emails.auth_registration_emails_email_unique", "UNIQUE btree (email)"],
  ["auth_registration_grants.auth_registration_grants_pkey", "UNIQUE btree (id)"],
  ["auth_registration_grants.auth_registration_grants_token_hash_unique", "UNIQUE btree (token_hash)"],
  ["communities.communities_pkey", "UNIQUE btree (id)"],
  ["community_memberships.community_memberships_user_id_community_id_pk", "UNIQUE btree (user_id, community_id)"],
  ["community_memberships.community_memberships_application_id_unique", "UNIQUE btree (application_id)"],
  ["community_reviewers.community_reviewers_community_id_user_id_pk", "UNIQUE btree (community_id, user_id)"],
  ["auth_identity_links.auth_identity_links_subject_unique", "UNIQUE btree (provider, external_user_id)"],
  ["auth_identity_links.auth_identity_links_user_provider_unique", "UNIQUE btree (user_id, provider)"],
  ["auth_registration_deliveries.auth_registration_deliveries_version_unique", "UNIQUE btree (registration_email_id, code_version)"],
  ["auth_registration_grants.auth_registration_grants_expiry_idx", "btree (expires_at)"],
  ["join_applications.join_applications_user_community_unique", "UNIQUE btree (user_id, community_id) WHERE (user_id IS NOT NULL)"],
  ["join_applications.join_applications_identity_unique", "UNIQUE btree (id, user_id, community_id)"],
  ["join_applications.join_applications_community_list_idx", "btree (community_id, status, created_at, id)"],
  ["join_applications.join_applications_owner_idx", "btree (user_id, community_id)"]
] as const) APPLICATION_INDEX_SIGNATURES.set(name, definition)
APPLICATION_INDEX_SIGNATURES.delete('join_applications.join_applications_open_email_unique')

export function indexSignature(definition: string): string {
  const match = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING (.+)$/.exec(definition)
  return match ? `${match[1] ?? ''}${match[2]}` : definition
}

export async function assertDatabaseReady(db: SqlExecutor, schema = 'public', migrationsSchema = 'drizzle'): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[a-z_][a-z0-9_]*$/.test(migrationsSchema)) {
    throw new Error('无效的 Server schema 名称。')
  }
  const tables = await db.query<{ tablename: string }>(
    'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1', [schema])
  const found = new Set(tables.rows.map(row => row.tablename))
  const missing = APPLICATION_TABLES.filter(table => !found.has(table))
  if (missing.length) throw new Error(`Server 数据表缺失（${missing.join(', ')}）；请运行 pnpm db:migrate。`)

  const columns = await db.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: 'YES' | 'NO'
  }>(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = ANY($2::text[])`, [schema, APPLICATION_TABLES])
  const actualColumns = new Map<string, Map<string, { type: string; nullable: boolean }>>()
  for (const column of columns.rows) {
    const table = actualColumns.get(column.table_name) ?? new Map()
    table.set(column.column_name, { type: column.data_type, nullable: column.is_nullable === 'YES' })
    actualColumns.set(column.table_name, table)
  }
  for (const table of tableDefinitions) {
    const actual = actualColumns.get(table.name) ?? new Map()
    if (actual.size !== table.columns.length || table.columns.some(column => {
      const stored = actual.get(column.name)
      return !stored || stored.type !== column.getSQLType() || stored.nullable === column.notNull
    })) {
      throw new Error(`Server 数据表结构不完整（${table.name}）；请人工核查 migration。`)
    }
  }

  const indexes = await db.query<{
    tablename: string; indexname: string; indexdef: string
    indisvalid: boolean; indisready: boolean; indislive: boolean
  }>(`SELECT t.relname AS tablename, i.relname AS indexname,
      pg_catalog.pg_get_indexdef(i.oid) AS indexdef,
      x.indisvalid, x.indisready, x.indislive
    FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1`, [schema])
  const actualIndexes = new Set(indexes.rows.map(row => `${row.tablename}.${row.indexname}`))
  const missingIndexes = expectedIndexes.filter(index => !actualIndexes.has(index))
  if (missingIndexes.length) throw new Error(`Server 索引缺失（${missingIndexes.join(', ')}）；请运行 pnpm db:migrate。`)
  const changedIndexes = indexes.rows.filter(row => {
    const expected = APPLICATION_INDEX_SIGNATURES.get(`${row.tablename}.${row.indexname}`)
    return expected !== undefined && (
      indexSignature(row.indexdef) !== expected || !row.indisvalid || !row.indisready || !row.indislive
    )
  })
  if (changedIndexes.length) {
    throw new Error(`Server 索引定义与 migration 基线不一致（${changedIndexes.map(row => `${row.tablename}.${row.indexname}`).join(', ')}）；请人工核查。`)
  }

  const constraints = await db.query<{ table_name: string; conname: string; definition: string }>(`SELECT t.relname AS table_name, c.conname,
      pg_catalog.pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1`, [schema])
  const actualConstraints = new Set(constraints.rows.map(row => `${row.table_name}.${row.conname}`))
  const missingConstraints = expectedConstraints.filter(name => !actualConstraints.has(name))
  if (missingConstraints.length) throw new Error(`Server 约束缺失（${missingConstraints.join(', ')}）；请运行 pnpm db:migrate。`)
  const changedConstraints = constraints.rows.filter(row => {
    const expected = APPLICATION_CONSTRAINT_DEFINITIONS.get(`${row.table_name}.${row.conname}`)
    return expected !== undefined && row.definition !== expected
  })
  if (changedConstraints.length) {
    throw new Error(`Server 约束定义与 migration 基线不一致（${changedConstraints.map(row => `${row.table_name}.${row.conname}`).join(', ')}）；请人工核查。`)
  }

  const journal = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = '__drizzle_migrations'`,
    [migrationsSchema])
  if (journal.rows.length !== 1) throw new Error('Server migration 记录缺失；请运行 pnpm db:migrate。')
  const applied = await db.query(`SELECT 1 FROM "${migrationsSchema}"."__drizzle_migrations" LIMIT 1`)
  if (applied.rows.length !== 1) throw new Error('Server migration 尚未完成；请核查后显式运行 pnpm db:migrate。')

  // The caller's search_path is fixed to the same schema; no value is interpolated as SQL.
  const admin = await db.query<{ code: string }>("SELECT code FROM community_groups WHERE code = 'admin'")
  if (admin.rows.length !== 1) throw new Error('Server admin 基础记录缺失；请运行 pnpm db:migrate。')
}
