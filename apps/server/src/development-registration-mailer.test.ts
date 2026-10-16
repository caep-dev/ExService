import {expect,it,vi} from 'vitest'
it('development mail simulation requires explicit opt-in and refuses production use',async()=>{
  const path='./development-registration-mailer.js',module=await import(path).catch(()=>undefined)
  expect(module).toBeDefined()
  expect(module!.developmentRegistrationMailer({NODE_ENV:'development'})).toBeUndefined()
  expect(()=>module!.developmentRegistrationMailer({NODE_ENV:'production',SERVER_REGISTRATION_MAIL_SIMULATOR:'true'})).toThrow('SERVER_REGISTRATION_MAIL_SIMULATOR requires development mode.')
  const output:Array<unknown>=[]
  const mailer=module!.developmentRegistrationMailer({NODE_ENV:'development',SERVER_REGISTRATION_MAIL_SIMULATOR:'true'},async(value:unknown)=>{output.push(value)})!
  await mailer.send({recipient:'member@example.com',code:'001234',codeExpiresAt:123,attemptId:'10000000-0000-4000-8000-000000000001',signal:new AbortController().signal})
  expect(output).toEqual([{channel:'registration-mail:development',recipient:'member@example.com',code:'001234',codeExpiresAt:123,attemptId:'10000000-0000-4000-8000-000000000001'}])
})

it('routes the real simulator output through runtime redaction without retaining the mailbox or code',async()=>{
  const {developmentRegistrationMailer}=await import('./development-registration-mailer.js')
  const {reporter}=await import(new URL('../../../scripts/runtime/output.mjs',import.meta.url).href)
  const {redact}=await import(new URL('../../../scripts/runtime/ownership.mjs',import.meta.url).href)
  const environment={NODE_ENV:'development',SERVER_REGISTRATION_MAIL_SIMULATOR:'true'}
  const emitted:string[]=[]
  const stderr=vi.spyOn(process.stderr,'write').mockImplementation(((value:string,done?:(error?:Error)=>void)=>{
    emitted.push(String(value));done?.();return true
  }) as typeof process.stderr.write)
  try {
    await developmentRegistrationMailer(environment)!.send({recipient:'synthetic@example.invalid',code:'001234',
      codeExpiresAt:123,attemptId:'10000000-0000-4000-8000-000000000001',signal:new AbortController().signal})
  } finally {stderr.mockRestore()}
  expect(emitted).toHaveLength(1)
  for(const isTTY of [true,false]){
    const displayed:string[]=[],retained:string[]=[]
    const output=reporter({environment,stream:{isTTY},colorEnvironment:{},write:(line:string)=>displayed.push(line),
      persist:(line:string)=>retained.push(line)})
    output.log('server',redact(emitted[0],environment),'stderr')
    expect(retained.join('\n')).not.toMatch(/001234|synthetic@example\.invalid/)
    expect(displayed.join('\n').includes('001234')).toBe(isTTY)
  }
})
