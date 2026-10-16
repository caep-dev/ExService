import { afterEach, expect, it } from 'vitest'
import { isolatedPostgres } from '@tests/helpers/postgres'
import { createNotificationModule } from '@server/src/modules/notifications/factory'
import type { PublishInput } from '@server/src/modules/notifications/producer'
const closers:Array<()=>Promise<void>>=[]
afterEach(async()=>{await Promise.all(closers.splice(0).map(close=>close()))})
const userId='10000000-0000-4000-8000-000000000001'
async function fixture(disabled=false) {
  const isolated=await isolatedPostgres();closers.push(isolated.close)
  await isolated.db.query('INSERT INTO auth_users(id,email,nickname,password_hash,created_at,disabled_at) VALUES ($1,$2,$3,$4,1,$5)',[userId,'m@example.com','Member','test-hash',disabled?2:null])
  const notifications=createNotificationModule({db:isolated.db,tokenKey:Buffer.alloc(32,3),now:()=>100})
  return {...isolated,notifications}
}
function publication(eventType:PublishInput['eventType']='personal.notice.issued'):PublishInput {
  return {eventType,dedupeKey:'tx-result',actorUserId:userId,audience:{kind:'users',userIds:[userId]},sourceType:'join_application',sourceId:'20000000-0000-4000-8000-000000000001',
    content:{title:'Result',html:'<p>Community decision</p>',templateId:'join-result',templateVersion:1,sourceRevision:1,
      actionsJson:'[]',availableAt:50,expiresAt:null}}
}
it('rolls back content, event and recipients when the enclosing business transaction fails',async()=>{
  const f=await fixture()
  await expect(f.db.transaction(async tx=>{
    await f.notifications.producer.publishInside(tx,publication())
    throw new Error('business write failed')
  })).rejects.toThrow('business write failed')
  for(const table of ['notification_contents','notification_events','notification_event_recipients'])
    expect((await f.db.query<{n:number}>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n).toBe(0)
})
it('keeps disabled applicants in necessary result event snapshots while ordinary personal notices reject them',async()=>{
  const f=await fixture(true)
  await expect(f.notifications.producer.publish(publication())).rejects.toMatchObject({code:'NOTIFICATION_AUDIENCE_INVALID'})
  const input=publication('join.application.approved')
  input.content.actionsJson=JSON.stringify([{kind:'navigate',actionId:'result',targetKey:'community.application-result',emphasis:'primary'}])
  const published=await f.db.transaction(tx=>f.notifications.producer.publishInside(tx,input,{occurredAt:50}))
  expect(published.audienceCount).toBe(1)
  const event=(await f.db.query('SELECT occurred_at,scope FROM notification_events WHERE event_id=$1',[published.eventId])).rows[0]!
  expect(event).toMatchObject({occurred_at:50,scope:'personal'})
  await f.notifications.worker.runRound()
  expect((await f.db.query('SELECT state FROM notification_event_recipients WHERE event_id=$1',[published.eventId])).rows[0]).toMatchObject({state:'skipped_disabled'})
})
it('result event audience cannot be broadened to an all-users publication',async()=>{
  const f=await fixture()
  const input=publication('join.application.rejected');input.audience={kind:'all_active_users'}
  await expect(f.notifications.producer.publish(input)).rejects.toMatchObject({code:'NOTIFICATION_AUDIENCE_INVALID'})
  expect((await f.db.query<{n:number}>('SELECT count(*) AS n FROM notification_events')).rows[0]!.n).toBe(0)
})
