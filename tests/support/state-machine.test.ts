import { randomUUID } from 'node:crypto'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createTestAuth,type TestAuth } from '@tests/helpers/auth'
import { supportFixture,requestInput,typeOption,departmentOption } from '@tests/helpers/support-clickup'
import { sha256, content, normalizeStoredPrepare } from '@server/src/domains/support/validation'
import { finalMarkdown } from '@server/src/domains/support/markdown'
import { createSupportServices } from '@server/src/domains/support/service'
import { createSupportMaintenance } from '@server/src/domains/support/maintenance'
import { ClickUpError } from '@server/src/modules/clickup/errors'
import { TARGET, frozenTaskInput } from '@server/src/domains/support/metadata'
import { resolveErrorResponse } from '@server/src/errors'
const fixtures:TestAuth[]=[]
afterEach(async()=>{await Promise.all(fixtures.splice(0).map(f=>f.close()))})
async function setup(){const f=await createTestAuth();fixtures.push(f);return {f,...await supportFixture(f)}}
describe('persistent support state machine',()=>{
  it('continues a previously frozen Bug without a category after new intake requires one',async()=>{
    const {f,userId,fake,support}=await setup()
    const original=(await support.prepare(userId,requestInput())).snapshot
    const frozenInput=normalizeStoredPrepare({submissionKey:original.submissionKey,form:{kind:'bug',title:'已接收的问题',typeOptionId:null,largeFileInfo:null,details:{description:'原问题内容',reproductionSteps:null,expectedResult:null,actualResult:null,frequency:null}},attachments:[]})
    const userMarkdown=content(frozenInput.form),markdown=finalMarkdown(userMarkdown,original.id)
    const taskJson=JSON.stringify(frozenTaskInput(frozenInput.form,markdown,'反馈用户',userId))
    await f.db.query("UPDATE support_feedback_submissions SET form_kind='bug',form_json=$2,user_markdown=$3,final_markdown=$4,payload_sha256=$5,task_payload_json=$6,task_payload_sha256=$7 WHERE id=$1",[original.id,JSON.stringify(frozenInput.form),userMarkdown,markdown,sha256(JSON.stringify(frozenInput)),taskJson,sha256(taskJson)])
    expect((await support.get(userId,original.id)).form).toMatchObject({kind:'bug',typeOptionId:null})
    const completed=(await support.advance(userId,original.id,{expectedRevision:original.revision,intent:'continue'})).snapshot
    expect(completed.status).toBe('completed')
    expect(fake.createTask).toHaveBeenCalledTimes(1)
    expect(fake.createTask.mock.calls[0]![1].custom_fields.map(field=>field.id)).not.toContain(TARGET.type)
  })
  it('uses the persisted task mapping for GET and create after mappings change',async()=>{
    const {f,userId,fake,support}=await setup()
    const snapshot=(await support.prepare(userId,requestInput())).snapshot
    const row=(await f.db.query<{task_payload_json:string}>('SELECT task_payload_json FROM support_feedback_submissions WHERE id=$1',[snapshot.id])).rows[0]!
    const frozen=JSON.parse(row.task_payload_json)
    const oldUserId=randomUUID()
    const oldListId='901810170999'
    fake.fields.push({ ...fake.fields.find(field=>field.id===TARGET.user)!, id: oldUserId })
    const create=fake.createTask.getMockImplementation()!
    fake.createTask.mockImplementation(async (list,input)=>{const result=await create(list,input);fake.tasks.get(result.id)!.list.id=list;return result})
    frozen.listId=oldListId
    frozen.task.custom_item_id=7777
    frozen.task.status='Archived intake'
    frozen.task.custom_fields[0].id=oldUserId
    const serialized=JSON.stringify(frozen)
    await f.db.query('UPDATE support_feedback_submissions SET task_payload_json=$2,task_payload_sha256=$3,target_list_id=$4 WHERE id=$1',[snapshot.id,serialized,sha256(serialized),oldListId])
    expect((await support.get(userId,snapshot.id)).form.kind).toBe('request')
    const completed=(await support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'continue'})).snapshot
    expect(completed.status).toBe('completed')
    expect(fake.createTask.mock.calls[0]![1]).toMatchObject({custom_item_id:7777,status:'Archived intake'})
    expect(fake.createTask.mock.calls[0]![0]).toBe(oldListId)
  })
  it('creates all six task types from frozen payloads with action tags in the create request',async()=>{
    const {f,userId,support,fake}=await setup()
    const base=requestInput().form
    const forms=[
      {kind:'bug',title:'Bug',typeOptionId:typeOption,largeFileInfo:null,details:{description:'问题',reproductionSteps:null,expectedResult:null,actualResult:null,frequency:null}},
      {kind:'feature',title:'功能',typeOptionId:null,departmentOptionId:null,largeFileInfo:null,contentText:'内容'},
      {kind:'asset',title:'资源',typeOptionId:null,action:'add',largeFileInfo:null,contentText:'内容'},
      {...base,title:'需求'},
      {kind:'content',title:'文档',action:'other',largeFileInfo:null,contentText:'内容'},
      {kind:'campaign',title:'宣传',largeFileInfo:null,contentText:'内容'},
    ] as const
    const expected=[1001,0,1009,1005,1007,1008]
    for(const [index,form] of forms.entries()) {
      let snapshot=(await support.prepare(userId,{submissionKey:randomUUID(),form,attachments:[]})).snapshot
      const frozen=(await f.db.query<{task_payload_json:string}>('SELECT task_payload_json FROM support_feedback_submissions WHERE id=$1',[snapshot.id])).rows[0]!
      expect(JSON.parse(frozen.task_payload_json).listId).toBe(TARGET.list)
      snapshot=(await support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'continue'})).snapshot
      expect(snapshot.status).toBe('completed')
      const sent=fake.createTask.mock.calls[index]![1]
      expect(sent.custom_item_id).toBe(expected[index])
      expect(sent.tags).toEqual(index===2?['新增']:[])
      expect(sent.custom_fields.map(field=>field.id)).not.toContain('4acf848b-2a8d-4404-8cda-36156e0f066d')
    }
    expect(fake.createTask).toHaveBeenCalledTimes(6)
  })
  it('accepts exact 20 MiB bytes, rejects excess/six declarations and keeps zero-file receiving until advance',async()=>{
    const {userId,support}=await setup(),bytes=Buffer.alloc(20971520,97),id=randomUUID()
    const a={id,originalName:'max.bin',contentType:'application/octet-stream',byteLength:bytes.length,sha256:sha256(bytes)}
    const input={...requestInput(),attachments:[a]}
    const s=(await support.prepare(userId,input)).snapshot
    expect((await support.upload(userId,s.id,id,{bytes,filename:'max.bin',contentType:'application/octet-stream'})).attachments[0]!.status).toBe('received')
    await expect(support.upload(userId,s.id,id,{bytes:Buffer.alloc(20971521),filename:'max.bin',contentType:'application/octet-stream'})).rejects.toMatchObject({code:'FEEDBACK_TOO_LARGE'})
    await expect(support.prepare(userId,{...requestInput(),attachments:Array.from({length:6},()=>({...a,id:randomUUID()}))})).rejects.toMatchObject({code:'FEEDBACK_INVALID_INPUT'})
    const zero=(await support.prepare(userId,requestInput())).snapshot
    expect(zero.status).toBe('receiving');expect(zero.nextAction).toBe('upload')
  })
  it('caps synchronization at two operations and drain rejects new work until existing results settle',async()=>{
    const {f,userId,fake,support}=await setup()
    const one=(await support.prepare(userId,requestInput())).snapshot,two=(await support.prepare(userId,requestInput())).snapshot
    const other=await f.seedUser({email:'slots@test.invalid',nickname:'Other',password:'valid password'}),three=(await support.prepare(other,requestInput())).snapshot
    const releases:Array<()=>void>=[]
    fake.createTask.mockImplementation(()=>new Promise((_resolve,reject)=>{releases.push(()=>reject(new ClickUpError('unknown','UPSTREAM_UNKNOWN')))}))
    const pending=[support.advance(userId,one.id,{expectedRevision:0,intent:'continue'}),support.advance(userId,two.id,{expectedRevision:0,intent:'continue'})]
    await vi.waitFor(()=>expect(fake.createTask).toHaveBeenCalledTimes(2))
    await expect(support.advance(other,three.id,{expectedRevision:0,intent:'continue'})).rejects.toMatchObject({code:'FEEDBACK_BUSY'})
    let drained=false
    const drain=support.close().then(()=>{drained=true})
    await Promise.resolve();expect(drained).toBe(false)
    releases.forEach(release=>release());await Promise.all(pending);await drain
    expect(drained).toBe(true)
    await expect(support.advance(other,three.id,{expectedRevision:0,intent:'continue'})).rejects.toMatchObject({code:'FEEDBACK_BUSY'})
    expect((await support.get(other,three.id)).status).toBe('receiving')
  })
  it('limits ten new records per ten minutes while old-key replay remains available',async()=>{
    const {userId,support}=await setup(),first=requestInput()
    for(let index=0;index<10;index++) {
      const s=(await support.prepare(userId,index===0?first:requestInput())).snapshot
      await support.advance(userId,s.id,{expectedRevision:0,intent:'continue'})
    }
    await expect(support.prepare(userId,requestInput())).rejects.toMatchObject({code:'FEEDBACK_RATE_LIMITED'})
    expect((await support.prepare(userId,first)).snapshot.status).toBe('completed')
  })
  it('serializes concurrent prepare by user/key, keeps nickname immutable and detects conflicts',async()=>{
    const {f,userId,support}=await setup(),input=requestInput()
    const values=await Promise.all([support.prepare(userId,input),support.prepare(userId,input)])
    expect(values.filter(v=>v.created)).toHaveLength(1);expect(values[0]!.snapshot.id).toBe(values[1]!.snapshot.id)
    const login=await f.authServices.login({email:'support@example.com',password:'valid password'})
    const session=await f.authServices.authenticateToken(login.token)
    await f.profileServices.update(userId,{nickname:'后来昵称'},tx=>f.authServices.assertSessionCurrent(session,tx,true))
    expect((await support.prepare(userId,input)).snapshot).toEqual(values[0]!.snapshot)
    await expect(support.prepare(userId,{...input,form:{...input.form,title:'changed'}})).rejects.toMatchObject({code:'FEEDBACK_PAYLOAD_CONFLICT'})
    const other=await f.seedUser({email:'other@test.invalid',nickname:'Other',password:'valid password'})
    expect((await support.prepare(other,input)).snapshot.id).not.toBe(values[0]!.snapshot.id)
    await expect(support.get(other,values[0]!.snapshot.id)).rejects.toMatchObject({code:'NOT_FOUND'})
    await expect(support.lookup(other,input.submissionKey+'x')).rejects.toMatchObject({code:'NOT_FOUND'})
  })
  it('enforces receiving quotas with concurrent distinct prepares and replays do not consume quota',async()=>{
    const {f,userId,support}=await setup()
    const results=await Promise.allSettled([support.prepare(userId,requestInput()),support.prepare(userId,requestInput()),support.prepare(userId,requestInput())])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2)
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'FEEDBACK_RATE_LIMITED'}})
    f.advance(86400000)
    expect((await support.prepare(userId,requestInput())).created).toBe(true)
  })
  it('receives immutable attachments, blocks missing bytes, writes one step per revision and releases bytea',async()=>{
    const {f,userId,fake,support}=await setup(),bytes=Buffer.from('attachment'),id=randomUUID()
    const input={...requestInput(),attachments:[{id,originalName:'中文.txt',contentType:'text/plain',byteLength:bytes.length,sha256:sha256(bytes)}]}
    let s=(await support.prepare(userId,input)).snapshot
    await expect(support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).rejects.toMatchObject({code:'FEEDBACK_STATE_CONFLICT'})
    expect(fake.createTask).not.toHaveBeenCalled()
    await expect(support.upload(userId,s.id,id,{bytes:Buffer.from('incorrect'),filename:'中文.txt',contentType:'text/plain'})).rejects.toMatchObject({code:'FEEDBACK_PAYLOAD_CONFLICT'})
    s=await support.upload(userId,s.id,id,{bytes,filename:'中文.txt',contentType:'text/plain'})
    const replay=await support.upload(userId,s.id,id,{bytes,filename:'中文.txt',contentType:'text/plain'})
    expect(replay.revision).toBe(s.revision)
    const before=s.revision
    const [first,second]=await Promise.all([support.advance(userId,s.id,{expectedRevision:before,intent:'continue'}),support.advance(userId,s.id,{expectedRevision:before,intent:'continue'})])
    expect(fake.createTask).toHaveBeenCalledTimes(1);expect(fake.service.uploadAttachment).not.toHaveBeenCalled()
    s=await support.get(userId,s.id);expect(s.taskId).toBe('task-1');expect(s.status).toBe('uploading')
    const stale=await support.advance(userId,s.id,{expectedRevision:before,intent:'continue'})
    expect(stale.statusCode).toBe(200);expect(fake.service.uploadAttachment).not.toHaveBeenCalled()
    const final=await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})
    expect(final.statusCode).toBe(200);expect(final.snapshot.nextAction).toBe('done');expect(fake.service.uploadAttachment).toHaveBeenCalledTimes(1)
    expect((await f.db.query('SELECT bytes FROM support_feedback_attachments WHERE submission_id=$1',[s.id])).rows[0]!.bytes).toBeNull()
    const uploadedReplay=await support.upload(userId,s.id,id,{bytes,filename:'中文.txt',contentType:'text/plain'})
    expect(uploadedReplay.revision).toBe(final.snapshot.revision);expect(fake.service.uploadAttachment).toHaveBeenCalledTimes(1)
    expect([first.snapshot.id,second.snapshot.id]).toEqual([s.id,s.id])
  })
  it('rejects same-length persisted bytea corruption before claim and preserves immutable progress',async()=>{
    const {f,userId,fake,support}=await setup(),bytes=Buffer.from('proof'),corrupted=Buffer.from('WRONG'),id=randomUUID()
    const input={...requestInput(),attachments:[{id,originalName:'proof.txt',contentType:'text/plain',byteLength:bytes.length,sha256:sha256(bytes)}]}
    let s=(await support.prepare(userId,input)).snapshot
    s=await support.upload(userId,s.id,id,{bytes,filename:'proof.txt',contentType:'text/plain'})
    await f.db.query('UPDATE support_feedback_attachments SET bytes=$3 WHERE submission_id=$1 AND id=$2',[s.id,id,corrupted])
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    expect(s.status).toBe('uploading')
    const before=s
    const error=await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'}).then(()=>undefined,error=>error)
    expect(error).toBeInstanceOf(Error)
    expect(resolveErrorResponse(error,{error:vi.fn(),warn:vi.fn()},'corruption')).toMatchObject({statusCode:500,code:'INTERNAL_ERROR'})
    expect(fake.service.uploadAttachment).not.toHaveBeenCalled()
    expect(await support.get(userId,s.id)).toEqual(before)
    const record=(await f.db.query('SELECT revision,attempt_id,failure_code FROM support_feedback_submissions WHERE id=$1',[s.id])).rows[0]!
    expect(Number(record.revision)).toBe(before.revision);expect(record.attempt_id).toBeNull();expect(record.failure_code).toBeNull()
    const attachment=(await f.db.query('SELECT status,bytes,remote_attachment_id FROM support_feedback_attachments WHERE submission_id=$1 AND id=$2',[s.id,id])).rows[0]!
    expect(attachment.status).toBe('received');expect(attachment.bytes).toEqual(corrupted);expect(attachment.remote_attachment_id).toBeNull()
    await f.db.query('UPDATE support_feedback_attachments SET bytes=$3 WHERE submission_id=$1 AND id=$2',[s.id,id,bytes])
    expect((await support.advance(userId,s.id,{expectedRevision:before.revision,intent:'continue'})).snapshot.status).toBe('completed')
    expect(fake.createTask).toHaveBeenCalledTimes(1);expect(fake.service.uploadAttachment).toHaveBeenCalledTimes(1)
  })
  it('enters verification on unknown create, never repeats POST, requires explicit evidence to retry',async()=>{
    const {f,userId,fake,support}=await setup()
    fake.createTask.mockRejectedValueOnce(new ClickUpError('unknown','UPSTREAM_UNKNOWN'))
    let s=(await support.prepare(userId,requestInput())).snapshot
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    expect(s.status).toBe('verification_required');expect(s.nextAction).toBe('verify')
    expect((await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'retry'})).statusCode).toBe(200)
    expect(fake.createTask).toHaveBeenCalledTimes(1)
    const maintenance=createSupportMaintenance({db:f.db,clickup:fake.service,now:f.now})
    const inspected=await maintenance.inspect(s.id)
    await expect(maintenance.confirmNotWritten(s.id,inspected.attempt!.id,{evidenceKind:'timeout',providerReference:'lookup returned nothing',observedAt:f.now(),confirmedNotExecuted:true},true)).rejects.toThrow()
    await maintenance.confirmNotWritten(s.id,inspected.attempt!.id,{evidenceKind:'provider_confirmation',providerReference:'provider-ticket-42',observedAt:f.now(),confirmedNotExecuted:true},true)
    s=await support.get(userId,s.id);expect(s.status).toBe('failed')
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'retry'})).snapshot
    expect(s.status).toBe('completed');expect(fake.createTask).toHaveBeenCalledTimes(2)
  })
  it('saves known task ID before read-back failure and maintenance cannot confirm creation absent',async()=>{
    const {f,userId,fake,support}=await setup()
    vi.mocked(fake.service.getTask).mockRejectedValueOnce(new ClickUpError('rejected','UPSTREAM_REJECTED'))
    let s=(await support.prepare(userId,requestInput())).snapshot
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    expect(s.taskId).toBe('task-1');expect(s.status).toBe('verification_required')
    const m=createSupportMaintenance({db:f.db,clickup:fake.service,now:f.now}),local=await m.inspect(s.id)
    await expect(m.confirmNotWritten(s.id,local.attempt!.id,{evidenceKind:'explicit_rejection',providerReference:'provider-42',observedAt:f.now(),confirmedNotExecuted:true},true)).rejects.toMatchObject({code:'FEEDBACK_STATE_CONFLICT'})
    await m.resolveTask(s.id,local.attempt!.id,'task-1',true)
    expect((await support.get(userId,s.id)).status).toBe('completed');expect(fake.createTask).toHaveBeenCalledTimes(1)
  })
  it('checks dropdown UUID/orderindex and every sent field without Bug department',async()=>{
    const {userId,fake,support}=await setup(),input={...requestInput(),form:{kind:'bug' as const,title:'Bug',typeOptionId:typeOption,largeFileInfo:'https://example.com/large\n提取码 abc',details:{description:'中文问题',reproductionSteps:null,expectedResult:null,actualResult:null,frequency:'once' as const}}}
    const original=fake.service.getTask
    fake.service.getTask=vi.fn(async id=>{const task=await original(id);for(const field of task.custom_fields)if(field.type==='drop_down')field.value=Number(field.type_config.options!.find(o=>o.id===field.value)!.orderindex);return task})
    let s=(await support.prepare(userId,input)).snapshot
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    expect(s.status).toBe('completed');expect(fake.createTask.mock.calls[0]![1].custom_fields).not.toContainEqual(expect.objectContaining({id:TARGET.department}))
    const another=(await support.prepare(userId,requestInput())).snapshot
    fake.service.getTask=vi.fn(async id=>{const task=await original(id);task.custom_fields=[];return task})
    expect((await support.advance(userId,another.id,{expectedRevision:another.revision,intent:'continue'})).snapshot.status).toBe('verification_required')
  })
  it('persists 429 cooldown, rejects continue and early retry; explicit retry resumes',async()=>{
    const {f,userId,fake,support}=await setup()
    fake.createTask.mockRejectedValueOnce(new ClickUpError('rate_limited','UPSTREAM_RATE_LIMITED',30))
    let s=(await support.prepare(userId,requestInput())).snapshot
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    expect(s.status).toBe('failed');expect(s.failure?.retryAfterSeconds).toBe(30)
    for(const intent of ['continue','retry'] as const)await expect(support.advance(userId,s.id,{expectedRevision:s.revision,intent})).rejects.toMatchObject({code:'FEEDBACK_STATE_CONFLICT'})
    f.advance(30000)
    expect((await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'retry'})).snapshot.status).toBe('completed')
  })
  it('keeps attachment bytes after a definite upload rejection and retries only on explicit intent',async()=>{
    const {f,userId,fake,support}=await setup(),bytes=Buffer.from('retryable attachment'),attachmentId=randomUUID()
    const input={...requestInput(),attachments:[{id:attachmentId,originalName:'retry.txt',contentType:'text/plain',byteLength:bytes.length,sha256:sha256(bytes)}]}
    let snapshot=(await support.prepare(userId,input)).snapshot
    snapshot=await support.upload(userId,snapshot.id,attachmentId,{bytes,filename:'retry.txt',contentType:'text/plain'})
    snapshot=(await support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'continue'})).snapshot
    vi.mocked(fake.service.uploadAttachment).mockRejectedValueOnce(new ClickUpError('rejected','UPSTREAM_REJECTED'))
    snapshot=(await support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'continue'})).snapshot
    expect(snapshot).toMatchObject({status:'failed',nextAction:'retry',failure:{phase:'upload_attachment',attachmentId}})
    expect((await f.db.query('SELECT bytes,remote_attachment_id FROM support_feedback_attachments WHERE submission_id=$1 AND id=$2',[snapshot.id,attachmentId])).rows[0]).toEqual({bytes,remote_attachment_id:null})
    await expect(support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'continue'})).rejects.toMatchObject({code:'FEEDBACK_STATE_CONFLICT'})
    snapshot=(await support.advance(userId,snapshot.id,{expectedRevision:snapshot.revision,intent:'retry'})).snapshot
    expect(snapshot.status).toBe('completed')
    expect(fake.service.uploadAttachment).toHaveBeenCalledTimes(2)
  })
  it('boot recovery fences a late create response and GET never mutates expired attempts',async()=>{
    const {f,userId,fake,support}=await setup()
    let release!:(value:{id:string})=>void
    fake.createTask.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const s=(await support.prepare(userId,requestInput())).snapshot
    const inFlight=support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})
    await vi.waitFor(()=>expect(fake.createTask).toHaveBeenCalledTimes(1))
    const before=await support.get(userId,s.id)
    f.advance(90001)
    const expired=await support.get(userId,s.id);expect(expired.nextAction).toBe('verify');expect(expired.revision).toBe(before.revision)
    const newBoot=createSupportServices({db:f.db,clickup:fake.service,profile:f.profileServices,now:f.now})
    await newBoot.recover()
    release({id:'late-task'})
    expect((await inFlight).snapshot.status).toBe('verification_required');expect((await support.get(userId,s.id)).taskId).toBeNull()
  })
  it('does not let a late create result overwrite a maintenance decision',async()=>{
    const {f,userId,fake,support}=await setup()
    let release!:(value:{id:string})=>void
    fake.createTask.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const prepared=(await support.prepare(userId,requestInput())).snapshot
    const inFlight=support.advance(userId,prepared.id,{expectedRevision:prepared.revision,intent:'continue'})
    await vi.waitFor(()=>expect(fake.createTask).toHaveBeenCalledTimes(1))
    const running=await support.get(userId,prepared.id)
    f.advance(90001)
    const maintenance=createSupportMaintenance({db:f.db,clickup:fake.service,now:f.now})
    const attempt=(await maintenance.inspect(prepared.id)).attempt!.id
    await maintenance.confirmNotWritten(prepared.id,attempt,{evidenceKind:'provider_confirmation',providerReference:'provider-ticket-77',observedAt:f.now(),confirmedNotExecuted:true},true)
    const decided=await support.get(userId,prepared.id)
    expect(decided).toMatchObject({status:'failed',nextAction:'retry',taskId:null})
    expect(decided.revision).toBeGreaterThan(running.revision)
    release({id:'late-task'})
    expect((await inFlight).snapshot).toEqual(decided)
    expect((await support.get(userId,prepared.id)).revision).toBe(decided.revision)
    expect(fake.createTask).toHaveBeenCalledTimes(1)
  })
  it('reconciles unknown attachment with downloaded content proof, dry-run cleanup and corrupted snapshot refusal',async()=>{
    const {f,userId,fake,support}=await setup(),bytes=Buffer.from('proof'),id=randomUUID()
    const input={...requestInput(),attachments:[{id,originalName:'proof.txt',contentType:'text/plain',byteLength:bytes.length,sha256:sha256(bytes)}]}
    let s=(await support.prepare(userId,input)).snapshot
    s=await support.upload(userId,s.id,id,{bytes,filename:'proof.txt',contentType:'text/plain'})
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    vi.mocked(fake.service.uploadAttachment).mockImplementationOnce(async taskId=>{fake.tasks.get(taskId)!.attachments.push({id:'lost-upload',title:'proof.txt',size:bytes.length});throw new ClickUpError('unknown','UPSTREAM_UNKNOWN')})
    s=(await support.advance(userId,s.id,{expectedRevision:s.revision,intent:'continue'})).snapshot
    const m=createSupportMaintenance({db:f.db,clickup:fake.service,now:f.now}),local=await m.inspect(s.id)
    await expect(m.resolveAttachment(s.id,id,local.attempt!.id,'lost-upload',Buffer.from('wrong'),true)).rejects.toThrow()
    await m.resolveAttachment(s.id,id,local.attempt!.id,'lost-upload',bytes,true)
    expect((await support.get(userId,s.id)).status).toBe('completed')
    const receiving=(await support.prepare(userId,requestInput())).snapshot
    f.advance(86400001)
    expect((await m.cleanupExpired(f.now())).submissionIds).toEqual([receiving.id])
    expect((await support.get(userId,receiving.id)).nextAction).toBe('restart')
    await m.cleanupExpired(f.now(),true,true)
    await expect(support.get(userId,receiving.id)).rejects.toMatchObject({code:'NOT_FOUND'})
    await f.db.query('UPDATE support_feedback_submissions SET attachment_count=2 WHERE id=$1',[s.id])
    await expect(support.get(userId,s.id)).rejects.toThrow('Support record invariant failed')
  })
})
