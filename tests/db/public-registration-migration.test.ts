import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isolatedPostgres } from '@tests/helpers/postgres'
import { runMigrations } from '@server/src/db/migration-runner'
import { inspectPublicRegistrationHistory } from '@server/src/db/public-registration-inventory'
import { assertDatabaseReady } from '@server/src/db/schema-check'

const resources: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(resources.splice(0).map(resource => resource.close())) })
async function history(count = 6) {
  const isolated = await isolatedPostgres({ migrate: false }); resources.push(isolated)
  const folder = new URL('../../apps/server/drizzle/', import.meta.url)
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8'))
  await isolated.db.transaction(async tx => {
    await tx.query('CREATE TABLE __drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)')
    for (const entry of journal.entries.slice(0, count)) {
      const source = readFileSync(new URL(`${entry.tag}.sql`, folder), 'utf8')
      for (const sql of source.split('--> statement-breakpoint')) await tx.query(sql)
      await tx.query('INSERT INTO __drizzle_migrations (hash,created_at) VALUES ($1,$2)', [createHash('sha256').update(source).digest('hex'), entry.when])
    }
  })
  return { ...isolated, migrate: () => runMigrations({ connectionString: isolated.connectionString, searchPath: isolated.schema, migrationsSchema: isolated.schema }) }
}
async function seed(db: Awaited<ReturnType<typeof history>>['db']) {
  await db.query("INSERT INTO auth_users (id,email,nickname,password_hash,created_at,avatar_key) VALUES ('owner','owner@example.com','Owner','preserved-hash',20,'avatar.webp')")
  await db.query("INSERT INTO join_applications (id,email,nickname,qq,status,created_at,reviewed_at) VALUES ('mapped','owner@example.com','Old name','12345','approved',1,10),('unowned','unowned@example.com','Other','12345','pending',1,null)")
  await db.query("INSERT INTO join_invitations (id,application_id,status,issued_at,expires_at,code_version,code_digest,code_expires_at,completion_token_hash,completion_expires_at,completed_user_id,completed_at) VALUES ('done','mapped','completed',10,100,1,'old-code',90,'old-token',95,'owner',20),('active','unowned','active',1,100,1,'active-code',90,'active-token',95,null,null)")
  await db.query("INSERT INTO join_application_email_registry VALUES ('owner@example.com','mapped'),('unowned@example.com','unowned')")
  await db.query("INSERT INTO join_delivery_attempts(id,invitation_id,code_version,status,started_at,finished_at) VALUES ('delivery','done',1,'sent',10,11)")
  await db.query("INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES ('session-token','owner',20,100)")
}
const historicalForm = {
  applicationType: 'experienced', birthDate: '2000-01-01', applicantCategory: '100', department: 'leo',
  freeTime: 'weekends', discoveryChannels: ['friends'],
  answers: { previousServer: 'old', leaveReason: 'moving', previousDepartment: 'patrol', lawEnforcementExperience: 'some', highestRank: 'officer', punishmentHistory: 'none', deescalationEssay: 'a'.repeat(150), discretionEssay: 'b'.repeat(150), transferReason: 'moving' },
  commitments: { informationAccurate: true },
}
async function seedForm(db: Awaited<ReturnType<typeof history>>['db']) {
  await db.query("UPDATE join_applications SET form_version=1,created_at=1700000000000,reviewed_at=1700000000010 WHERE id='mapped'")
  await db.query("UPDATE join_invitations SET completed_at=1700000000020 WHERE id='done'")
  await db.query("INSERT INTO join_application_forms VALUES ('mapped',1,'experienced',$1)", [JSON.stringify(historicalForm)])
  const bytes = Buffer.from('retained attachment bytes')
  await db.query("INSERT INTO join_application_attachments VALUES ('proof','mapped',0,'proof.txt','txt',$1,$2,$3)", [createHash('sha256').update(bytes).digest('hex'), bytes.length, bytes])
}
it.each([1, 2, 3, 4, 5, 6])('upgrades complete historical prefix %i and preserves accounts', async count => {
  const h = await history(count); await seed(h.db)
  const before = (await h.db.query('SELECT id,email,nickname,password_hash,created_at,avatar_key FROM auth_users')).rows
  const preservedTables = ['join_application_email_registry', 'join_delivery_attempts', ...(count >= 2 ? ['auth_sessions'] : [])]
  if (count >= 2) {
    await h.db.query("INSERT INTO auth_oidc_bindings(client_id,hydra_sid,session_id,user_id,created_at) SELECT 'client','sid',id,'owner',20 FROM auth_sessions")
    preservedTables.push('auth_oidc_bindings')
  }
  if (count >= 3) {
    await h.db.query("INSERT INTO notification_user_streams(user_id,last_sequence,state_version) VALUES ('owner',2,3)")
    preservedTables.push('notification_user_streams')
  }
  if (count >= 5) {
    await h.db.query(`INSERT INTO support_feedback_submissions
      (id,user_id,submission_key,nickname_snapshot,form_kind,form_version,content_rule_version,
       form_json,user_markdown,final_markdown,payload_sha256,task_payload_json,task_payload_sha256,
       revision,status,attachment_count,total_attachment_bytes,created_at,receive_expires_at,updated_at,target_list_id)
      VALUES ('support-1','owner','key-1','Owner','request',2,1,'{}','text','text',$1,'{}',$2,
        0,'receiving',0,0,1,86400001,1,'list-1')`, ['0'.repeat(64), '1'.repeat(64)])
  }
  if (count >= 4) preservedTables.push('support_feedback_submissions', 'support_feedback_attachments')
  const retained = await Promise.all(preservedTables.map(table => h.db.query(`SELECT * FROM ${table}`)))
  await h.migrate()
  expect((await h.db.query('SELECT id,email,nickname,password_hash,created_at,avatar_key FROM auth_users')).rows).toEqual(before)
  expect((await h.db.query('SELECT user_id,community_id,application_id,joined_at FROM community_memberships')).rows).toEqual([{ user_id: 'owner', community_id: 'rifling-911', application_id: 'mapped', joined_at: 20 }])
  expect((await h.db.query('SELECT id,user_id,legacy_read_only FROM join_applications ORDER BY id')).rows).toEqual([{ id: 'mapped', user_id: 'owner', legacy_read_only: true }, { id: 'unowned', user_id: null, legacy_read_only: true }])
  expect((await h.db.query('SELECT status,code_digest,completion_token_hash FROM join_invitations ORDER BY id')).rows).toEqual([{ status: 'expired', code_digest: null, completion_token_hash: null }, { status: 'completed', code_digest: null, completion_token_hash: null }])
  for (const [index, table] of preservedTables.entries()) expect((await h.db.query(`SELECT * FROM ${table}`)).rows).toEqual(retained[index]!.rows)
  await h.migrate()
})
it('creates public registration tables in an empty schema', async () => {
  const h = await isolatedPostgres(); resources.push(h)
  expect((await h.db.query('SELECT id,requires_cfx FROM communities')).rows).toEqual([{ id: 'rifling-911', requires_cfx: true }])
  expect((await h.db.query('SELECT * FROM auth_registration_grants')).rows).toEqual([])
})
it.each(['duplicate_invitation', 'duplicate_user', 'time', 'missing_form', 'bad_form', 'bad_hash'] as const)('blocks corrupt history atomically: %s', async kind => {
  const h = await history(); await seed(h.db)
  if (kind === 'duplicate_invitation') await h.db.query("INSERT INTO join_invitations (id,application_id,status,issued_at,expires_at,code_version,completed_user_id,completed_at) VALUES ('duplicate','mapped','completed',10,100,1,'owner',20)")
  if (kind === 'duplicate_user') {
    await h.db.query("UPDATE join_applications SET status='approved',reviewed_at=10 WHERE id='unowned'")
    await h.db.query("UPDATE join_invitations SET status='completed',completed_user_id='owner',completed_at=20 WHERE id='active'")
  }
  if (kind === 'time') await h.db.query("UPDATE join_invitations SET completed_at=5 WHERE id='done'")
  if (['missing_form','bad_form'].includes(kind)) await h.db.query("UPDATE join_applications SET form_version=1 WHERE id='mapped'")
  if (kind === 'bad_form') await h.db.query("INSERT INTO join_application_forms VALUES ('mapped',1,'experienced','{}')")
  if (kind === 'bad_hash') {
    await seedForm(h.db)
    await h.db.query("UPDATE join_application_attachments SET sha256=$1", ['0'.repeat(64)])
    expect((await inspectPublicRegistrationHistory(h.db)).conflicts).toEqual({ ATTACHMENT_INVALID: 1 })
  }
  const before = (await h.db.query('SELECT * FROM join_invitations ORDER BY id')).rows
  await expect(h.migrate()).rejects.toThrow('PUBLIC_REGISTRATION_HISTORY_CONFLICT')
  expect((await h.db.query('SELECT * FROM join_invitations ORDER BY id')).rows).toEqual(before)
  expect((await h.db.query("SELECT to_regclass('communities') AS name")).rows).toEqual([{ name: null }])
})

it('inventories without disclosing or mutating personal data and preserves complete forms and bytes', async () => {
  const h = await history(); await seed(h.db); await seedForm(h.db)
  await h.db.query("UPDATE auth_users SET disabled_at=30 WHERE id='owner'")
  const snapshot = async () => ({ forms: (await h.db.query('SELECT * FROM join_application_forms')).rows, attachments: (await h.db.query('SELECT * FROM join_application_attachments')).rows, invitations: (await h.db.query('SELECT * FROM join_invitations ORDER BY id')).rows })
  const before = await snapshot()
  const inventory = await h.db.transaction(inspectPublicRegistrationHistory, 'repeatable-read-read-only')
  expect(inventory).toEqual({ counts: { applications: 2, mappedApplications: 1, unownedApplications: 1, forms: 1, attachments: 1, invitations: 2, deliveries: 1 }, conflicts: {} })
  expect(await snapshot()).toEqual(before)
  expect(JSON.stringify(inventory)).not.toMatch(/example|owner|old-token|attachment bytes/)
  await h.migrate()
  const after = await snapshot()
  expect(after.forms).toEqual(before.forms); expect(after.attachments).toEqual(before.attachments)
  expect((await h.db.query('SELECT joined_at FROM community_memberships')).rows).toEqual([{ joined_at: 1700000000020 }])
  // Unowned history is not claimed by matching email and does not reserve UUID's opportunity.
  await h.db.query("INSERT INTO auth_users(id,email,nickname,password_hash,created_at) VALUES ('new-owner','unowned@example.com','New','hash',30)")
  await h.db.query("INSERT INTO join_applications(id,email,nickname,qq,status,created_at,community_id,user_id) VALUES ('new-application','unowned@example.com','New','12345','pending',30,'rifling-911','new-owner')")
  await expect(h.db.query("INSERT INTO join_applications(id,email,nickname,qq,status,created_at,community_id,user_id) VALUES ('duplicate','other@example.com','New','12345','pending',30,'rifling-911','new-owner')")).rejects.toThrow()
})

it.each(['orphan_form','orphan_attachment','ordinal','length','category','birth_date','commitment'] as const)('blocks invalid historical storage: %s', async kind => {
  const h=await history(); await seed(h.db); await seedForm(h.db)
  if (kind.startsWith('orphan')) {
    const table=kind==='orphan_form'?'join_application_forms':'join_application_attachments'
    const constraints=await h.db.query<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'",[table])
    for (const row of constraints.rows) await h.db.query(`ALTER TABLE ${table} DROP CONSTRAINT "${row.name}"`)
    await h.db.query(`UPDATE ${table} SET application_id='absent'`)
  }
  if(kind==='ordinal') await h.db.query('UPDATE join_application_attachments SET ordinal=3')
  if(kind==='length') {
    await h.db.query('ALTER TABLE join_application_attachments DROP CONSTRAINT join_application_attachments_length_check')
    await h.db.query('UPDATE join_application_attachments SET byte_length=1')
  }
  if(['category','birth_date','commitment'].includes(kind)) {
    const form=structuredClone(historicalForm)
    if(kind==='category') form.applicantCategory='unknown'
    if(kind==='birth_date') form.birthDate='2000-02-31'
    if(kind==='commitment') form.commitments.informationAccurate=false
    await h.db.query('UPDATE join_application_forms SET form_json=$1',[JSON.stringify(form)])
  }
  await expect(h.migrate()).rejects.toThrow('PUBLIC_REGISTRATION_HISTORY_CONFLICT')
  expect((await h.db.query("SELECT to_regclass('communities') AS name")).rows).toEqual([{name:null}])
})

it('checks grant combinations, application ownership and new constraint definitions at readiness', async () => {
  const h=await isolatedPostgres();resources.push(h)
  await expect(h.db.query("INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,state,expires_at,created_at) VALUES ('g','token','browser','cfx','a@example.com','active',2,1)")).rejects.toThrow()
  await expect(h.db.query("INSERT INTO auth_registration_grants(id,token_hash,browser_binding_hash,kind,email,state,expires_at,created_at) VALUES ('g','token','browser','email','a@example.com','processing',2,1)")).rejects.toThrow()
  await expect(h.db.query("INSERT INTO join_applications(id,email,nickname,qq,status,created_at,community_id) VALUES ('a','a@example.com','A','12345','pending',1,'rifling-911')")).rejects.toThrow()
  await h.db.query('ALTER TABLE communities DROP CONSTRAINT communities_revision_check')
  await h.db.query('ALTER TABLE communities ADD CONSTRAINT communities_revision_check CHECK(config_revision >= -1)')
  await expect(assertDatabaseReady(h.db,h.schema,h.schema)).rejects.toThrow('migration')
})
