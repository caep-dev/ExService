CREATE TABLE "auth_identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"external_username" text NOT NULL,
	"provider_email" text,
	"linked_at" bigint NOT NULL,
	CONSTRAINT "auth_identity_links_provider_check" CHECK ("auth_identity_links"."provider" = 'cfx'),
	CONSTRAINT "auth_identity_links_subject_check" CHECK ("auth_identity_links"."external_user_id" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "auth_registration_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_email_id" text NOT NULL,
	"code_version" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "auth_registration_deliveries_version_check" CHECK ("auth_registration_deliveries"."code_version" >= 1),
	CONSTRAINT "auth_registration_deliveries_status_check" CHECK ("auth_registration_deliveries"."status" in ('pending', 'sent', 'failed')),
	CONSTRAINT "auth_registration_deliveries_finished_check" CHECK (("auth_registration_deliveries"."status" = 'pending' and "auth_registration_deliveries"."finished_at" is null) or ("auth_registration_deliveries"."status" <> 'pending' and "auth_registration_deliveries"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "auth_registration_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_version" integer DEFAULT 0 NOT NULL,
	"code_hmac" text,
	"code_expires_at" bigint,
	"code_browser_binding_hash" text,
	"next_send_at" bigint NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"failure_window_started_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "auth_registration_emails_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_registration_emails_version_check" CHECK ("auth_registration_emails"."code_version" >= 0),
	CONSTRAINT "auth_registration_emails_failures_check" CHECK ("auth_registration_emails"."failed_attempts" between 0 and 5),
	CONSTRAINT "auth_registration_emails_material_check" CHECK (("auth_registration_emails"."code_hmac" is null and "auth_registration_emails"."code_expires_at" is null and "auth_registration_emails"."code_browser_binding_hash" is null) or ("auth_registration_emails"."code_hmac" is not null and "auth_registration_emails"."code_expires_at" is not null and "auth_registration_emails"."code_browser_binding_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "auth_registration_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"kind" text NOT NULL,
	"email" text NOT NULL,
	"external_user_id" text,
	"external_username" text,
	"provider_email" text,
	"state" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"consumed_at" bigint,
	"processing_started_at" bigint,
	"completed_at" bigint,
	"completed_user_id" text,
	CONSTRAINT "auth_registration_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_registration_grants_kind_check" CHECK (("auth_registration_grants"."kind" = 'email' and "auth_registration_grants"."external_user_id" is null and "auth_registration_grants"."external_username" is null and "auth_registration_grants"."provider_email" is null) or ("auth_registration_grants"."kind" = 'cfx' and "auth_registration_grants"."external_user_id" is not null and "auth_registration_grants"."external_user_id" ~ '^[1-9][0-9]*$' and "auth_registration_grants"."external_username" is not null and "auth_registration_grants"."provider_email" is not null)),
	CONSTRAINT "auth_registration_grants_state_check" CHECK ("auth_registration_grants"."state" in ('active', 'processing', 'completed', 'failed')),
	CONSTRAINT "auth_registration_grants_processing_check" CHECK ("auth_registration_grants"."state" <> 'processing' or "auth_registration_grants"."processing_started_at" is not null),
	CONSTRAINT "auth_registration_grants_completed_check" CHECK (("auth_registration_grants"."state" = 'completed' and "auth_registration_grants"."completed_at" is not null and "auth_registration_grants"."completed_user_id" is not null) or ("auth_registration_grants"."state" <> 'completed' and "auth_registration_grants"."completed_at" is null and "auth_registration_grants"."completed_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"requires_cfx" boolean NOT NULL,
	"config_revision" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "communities_id_check" CHECK (char_length("communities"."id") between 1 and 64 and "communities"."id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "communities_display_name_check" CHECK (char_length("communities"."display_name") between 1 and 80),
	CONSTRAINT "communities_revision_check" CHECK ("communities"."config_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "community_memberships" (
	"user_id" text NOT NULL,
	"community_id" text NOT NULL,
	"application_id" text NOT NULL,
	"joined_at" bigint NOT NULL,
	CONSTRAINT "community_memberships_user_id_community_id_pk" PRIMARY KEY("user_id","community_id"),
	CONSTRAINT "community_memberships_application_id_unique" UNIQUE("application_id")
);
--> statement-breakpoint
CREATE TABLE "community_reviewers" (
	"community_id" text NOT NULL,
	"user_id" text NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"granted_at" bigint NOT NULL,
	CONSTRAINT "community_reviewers_community_id_user_id_pk" PRIMARY KEY("community_id","user_id")
);
--> statement-breakpoint
DROP INDEX "join_applications_open_email_unique";--> statement-breakpoint
ALTER TABLE "join_applications" ADD COLUMN "community_id" text;--> statement-breakpoint
ALTER TABLE "join_applications" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "join_applications" ADD COLUMN "legacy_read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "join_applications" ADD COLUMN "identity_snapshot_json" text;--> statement-breakpoint
INSERT INTO communities (id,display_name,requires_cfx,config_revision,created_at,updated_at) VALUES ('rifling-911','Rifling 911',true,0,(extract(epoch from transaction_timestamp())*1000)::bigint,(extract(epoch from transaction_timestamp())*1000)::bigint);
--> statement-breakpoint
UPDATE join_applications SET community_id='rifling-911', legacy_read_only=true;
--> statement-breakpoint
UPDATE join_applications a SET user_id=i.completed_user_id FROM join_invitations i WHERE i.application_id=a.id AND i.status='completed';
--> statement-breakpoint
ALTER TABLE join_applications ALTER COLUMN community_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "auth_identity_links" ADD CONSTRAINT "auth_identity_links_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_registration_deliveries" ADD CONSTRAINT "auth_registration_deliveries_registration_email_id_auth_registration_emails_id_fk" FOREIGN KEY ("registration_email_id") REFERENCES "auth_registration_emails"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_registration_grants" ADD CONSTRAINT "auth_registration_grants_completed_user_id_auth_users_id_fk" FOREIGN KEY ("completed_user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "community_reviewers" ADD CONSTRAINT "community_reviewers_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reviewers" ADD CONSTRAINT "community_reviewers_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reviewers" ADD CONSTRAINT "community_reviewers_granted_by_user_id_auth_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identity_links_subject_unique" ON "auth_identity_links" USING btree ("provider","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identity_links_user_provider_unique" ON "auth_identity_links" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_registration_deliveries_version_unique" ON "auth_registration_deliveries" USING btree ("registration_email_id","code_version");--> statement-breakpoint
CREATE INDEX "auth_registration_grants_expiry_idx" ON "auth_registration_grants" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "join_applications" ADD CONSTRAINT "join_applications_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_applications" ADD CONSTRAINT "join_applications_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_applications_user_community_unique" ON "join_applications" USING btree ("user_id","community_id") WHERE "join_applications"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "join_applications_identity_unique" ON "join_applications" USING btree ("id","user_id","community_id");--> statement-breakpoint
CREATE INDEX "join_applications_community_list_idx" ON "join_applications" USING btree ("community_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "join_applications_owner_idx" ON "join_applications" USING btree ("user_id","community_id");--> statement-breakpoint
ALTER TABLE "join_applications" ADD CONSTRAINT "join_applications_owner_check" CHECK ("join_applications"."legacy_read_only" or "join_applications"."user_id" is not null);--> statement-breakpoint
ALTER TABLE "join_applications" ADD CONSTRAINT "join_applications_reviewer_check" CHECK (("join_applications"."status" = 'pending' and "join_applications"."reviewed_by_user_id" is null) or ("join_applications"."status" <> 'pending' and ("join_applications"."legacy_read_only" or "join_applications"."reviewed_by_user_id" is not null)));
--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_application_owner_fk" FOREIGN KEY ("application_id","user_id","community_id") REFERENCES "join_applications"("id","user_id","community_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
INSERT INTO community_memberships(user_id,community_id,application_id,joined_at) SELECT i.completed_user_id,'rifling-911',i.application_id,i.completed_at FROM join_invitations i WHERE i.status='completed';
--> statement-breakpoint
UPDATE join_invitations SET status=CASE WHEN status='completed' THEN 'completed' ELSE 'expired' END,code_digest=null,code_expires_at=null,completion_token_hash=null,completion_expires_at=null;

--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_type_check";--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_type_check" CHECK ("notification_events"."event_type" in ('community.announcement.published', 'community.announcement.withdrawn', 'personal.notice.issued', 'join.application.approved', 'join.application.rejected'));