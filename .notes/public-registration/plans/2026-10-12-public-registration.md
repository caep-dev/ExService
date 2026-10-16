# Public registration implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` task by task. The current linked worktree is the execution workspace. No commits are requested.

**Goal:** Replace invitation-gated registration with public accounts, Cfx identity links, and authenticated community applications and reviews.

**Architecture:** Implement the accepted design through the module boundaries and transaction protocols in the RFC. Contract, Server, generated Client and Web switch together; retain the historical database facts and append a migration.

**Tech Stack:** TypeScript, Fastify 5, PostgreSQL 18, Drizzle, React, ExUI, React Hook Form, Zod, Vitest and PostgreSQL Testcontainers.

**Spec:** `.notes/public-registration/specs/2026-10-12-public-registration-and-community-membership-design.md`

**RFC:** `.notes/public-registration/rfcs/public-registration-and-community-membership-rfc.md`

## Global Constraints

- Contract version changes from `0.6.0` to the confirmed `0.7.0`; use Draft-07-compatible schemas.
- Every account has a password; Cfx registration does not assert verified email or merge duplicate email accounts.
- Each user UUID has one lifetime application per community across all states; Cfx is not the deduplication key.
- Preserve users, avatars, applications, forms, attachments, invitations and delivery history. No actual development database migration, reset, push, publish or deployment.
- Preserve all baseline untracked Cfx/Google materials; do not read external authorization evidence or secrets.
- Add behavioral regressions before implementation; use real services and real isolated PostgreSQL at database boundaries.
- Ordinary registration/login/links remain distinct from SSO. Google and QQ have disabled entries only.
- Reference all RFC timing, capacity, Cookie, advisory-lock and lock-order values verbatim. The RFC is the detailed authority for the following tasks.
- Existing dirty `.ai/` documentation is preserved and incrementally updated under the user's continuation instruction.

### Task 1: Database model, safe upgrade and historical inventory

**Files:** Modify `.ai/databases/data-model.md`, `apps/server/src/db/schema.ts`, `client.ts`, `schema-check.ts`, `migration-runner.ts`, `reset-plan.ts`, `apps/server/drizzle/meta/_journal.json`. Create `apps/server/drizzle/0003_public_registration_communities.sql`, its snapshot, `apps/server/src/db/public-registration-inventory.ts` and a dedicated read-only CLI. Tests in `tests/db/public-registration-migration.test.ts`.

**Interfaces:** Produce the exact tables/columns/checks in RFC sections 4 and 9; expose `inspectPublicRegistrationHistory(executor: SqlExecutor)` with only counts and safe conflict codes. Other tasks query these physical columns. Inventory never writes or prints personal information.

- [x] Update target table responsibilities before schema edits; preserve the identity and notification sections.
- [x] Write isolated migration tests for empty/historical prefixes, completed invitation mapping, unowned history, duplicate mappings, corrupted form/attachment, old credential retirement and preserved IDs/bytes.
- [x] Run `pnpm exec vitest run tests/db/public-registration-migration.test.ts` and establish the missing behavior.
- [x] Implement checks, append migration/snapshot, preserve explicit 0000/0001/0002 table sets, expose read-only inventory and readiness/reset ownership checks.
- [x] Rerun migration tests and existing database regressions; obtain task review without staging or committing.

### Task 2: Contract and generated Client

**Files:** Modify `api/openapi.yaml`, `api/paths/join.yaml`, `api/schemas/join.yaml`; create `api/paths/registration.yaml`, `identity-links.yaml`, `communities.yaml` and corresponding schema files. Regenerate `api/generated/openapi.json` and `packages/api-client/src/generated/schema.d.ts`. Modify `packages/api-client/src/client.ts` and its tests for public methods.

**Interfaces:** Produce all 24 RFC section 5 operations exactly once, retire section 9.2 operations, and preserve ordinary auth/profile/identity/storage/notification/Cfx operations. Shared DTOs are generated only. Client's multipart submission accepts path `communityId` and authenticated `{qq, form}` payload.

- [x] Define new schemas, safe errors and headers; remove live invitation fields while retaining truthful historical branches.
- [x] Generate using `pnpm api:lint` and `pnpm api:generate`.
- [x] Add Client request tests for path, Bearer, body, response union and multipart.
- [x] Implement Client methods through its existing transport; run focused tests and `pnpm api:check`.
- [x] Obtain task review of source and generated files.

### Task 3: Account transactions, registration and identity links

**Files:** Modify `apps/server/src/modules/auth/service.ts`, Cfx `types.ts` and `service.ts`; create `apps/server/src/modules/identity-links/` and `registration/` with service/factory, errors, business plugin, local `fastify.d.ts`, API operations, handlers and guards. Tests in `tests/registration/`, `tests/identity-links/`, `tests/cfx/service.test.ts` and `tests/contract/registration.test.ts`.

**Interfaces:** auth exposes `createAccountInside(tx, {email,nickname}, passwordHash)`, `createSessionInside(tx,userId)` and existing session checks. IdentityLinkService exposes `findBySubjectInside`, `listInside`, `createInside`, owner/session-bound Cfx intent and unlink operations. RegistrationService exposes request/verify/complete/signIn and bounded `start`/`close`; uses the shared PasswordHasher and injected RegistrationMailer.

- [x] Establish failing real Cfx regression for two ready attempts sharing one Cookie; implement optional `expectedAttemptId` check before consumption; 67 Cfx tests and dedicated typecheck pass.
- [x] Write database/HTTP regressions for RFC sections 6.1–6.3, including capacities, failed counter commit, browser binding, grant terminal states, restart persistence, duplicate account/link races, disabled users, intent/session/unwrap races and actual mail settlement.
- [x] Implement the services and operation-filtered guards without reverse dependencies or nested transactions. Cfx-disabled email registration, queries and unlink must continue to work.
- [x] Run focused suites; obtain task review.

### Task 4: Communities and scoped authorization

**Files:** Create `apps/server/src/modules/communities/` service/factory, errors, business plugin/local declarations, API handlers/operations/guards; tests in `tests/communities/` and `tests/contract/communities.test.ts`.

**Interfaces:** Produce `communityServices` and transaction-aware `assertReviewerInside`, `assertPlatformAdminInside`, `requirementsInside`, membership writes and paginated public/my/admin methods. Join consumes these methods and explicit lock protocol; platform admin never implicitly becomes reviewer.

- [x] Add real PostgreSQL permission, pagination, config revision, missing requirement and authorization revoke/disable concurrency tests.
- [x] Implement RFC section 5.2 operations, UUID-sorted account locks, session and community locks, stable scope checks and read snapshots.
- [x] Run focused suites and obtain task review.

### Task 5: Join replacement and atomic notifications

**Files:** Modify `apps/server/src/domains/join/` application service/repository/types/schema checks, plugin/local declarations and API handlers/operations; retire runtime invitation dependencies. Modify notification `producer.ts`, `repository.ts`, `catalog.ts`, `actions.ts`, HTML navigation validation. Tests in `tests/join/`, `tests/notifications/`, `tests/contract/join.test.ts`.

**Interfaces:** Join consumes authenticated SessionIdentity and community path ID; saves current account snapshots and `{qq,form}` plus proof files in one transaction. `notifications.producer.publishInside(tx,input,options)` performs all reads/writes on passed executor. Closed result-event catalog accepts exactly the applicant UUID including disabled users and preserves original reviewedAt.

- [x] Write regressions for lifetime uniqueness, two communities, current requirements, authorized list/detail/attachments, readonly historical branches, idempotent decisions, conflicting decisions and revoke races.
- [x] Add injected member/notification failure tests proving complete transaction rollback; same-decision replay must not republish after a rename.
- [x] Implement one-tx decisions, membership and necessary event publication; preserve ordinary producer audience semantics; register fixed `/join/result` navigation.
- [x] Run focused suites and obtain task review.

### Task 6: Browser flows and shared UI

**Files:** Replace `apps/web/src/invitations/InvitationRegistrationFlow.tsx` with public flow; modify AuthFlow, `apps/web/src/pages/AuthPage/InvitationRegistrationPage.tsx`, registration entries, settings/profile hosts, community join/result/review pages, App routes and `apps/web/src/join/client.ts`. Create Cfx attempt orchestration, IdentityLinksExperience, community management page and shared public-registration/identity-link forms. Modify relevant `packages/components/src/` exports and apply CSS Modules using ExUI tokens. Tests colocated with app and components.

**Interfaces:** All requests use generated Client. Shared forms/panels take props and callbacks. Join-origin login uses `onSessionCreated` while preserving mounted draft; token ownership change clears draft. Cfx tickets and grants remain memory-only. Result and reviewer selectors read current permissions from Server.

- [x] Read frontend form/notification rules and existing lifecycle tests; add user interaction regressions before UI changes.
- [x] Implement mailbox code/profile and Cfx manual/redirect union flow, disabled provider entries, optional callback-based session install, popup recovery/visible serial polling and safe cancellation.
- [x] Implement owner-scoped link settings with confirmation and joined-community impact, community application/own result/reviewer/admin pages, readonly history and retired invite query explanation/removal.
- [x] Run DOM and Client tests and obtain task review; record actual browser verification separately.

### Task 7: Assembly, regression migration and final gates

**Files:** Modify `apps/server/src/business-services.ts`, `create-services.ts`, `server.ts`, `http/plugin.ts`, `http/service-handlers.ts`, startup cleanup and test fixtures/type tests to require new services and remove InvitationService injection. Synchronize durable `.ai/` current behavior, accepted decisions and navigation without replacing baseline design source.

**Interfaces:** Construct shared auth/hasher/cfx/notifications then links/registration/communities/join; business plugins expose real decorators and explicit dependency checks. App does not own injected database; workers close before the shared database. Existing session/OIDC/profile/storage/notification tests keep their behavioral assertions and seed users directly instead of creating retired invitation accounts.

- [x] Add assembly/Contract coverage and retired path real-404 regressions; update fixture creation and registration seed utilities.
- [x] Run `pnpm api:lint`, `pnpm api:generate`, `pnpm api:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`; wait for actual exit codes and distinguish baseline failures.
- [x] Invoke independent `$code-review working-tree --paths` for the exact entire touched-path list, including untracked/generated/migration/documentation files. Fix blocking findings and repeat full coverage review.
- [x] Report automated, browser, external Cfx/mail and actual migration evidence distinctly; no commit requested.

Final evidence is retained in `.superpowers/sdd/2026-10-12-public-registration/delivery-summary.md` and its adjacent exact touched-path manifest. All required commands exited successfully; the unified test finished on 2026-10-12 at 19:44 Asia/Shanghai. The final two copy corrections and the additional duplicate-mailbox regression were independently rechecked with both affected test files and the Web build after the unified Website stage. Real external Cfx/mail, development-database migration, complete browser submission/review and deployment acceptance remain unexecuted.
