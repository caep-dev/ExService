// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {readToken,subscribeSessionChanges,writeToken} from './storage'
const post=vi.hoisted(()=>vi.fn())
vi.mock('@web/src/api/client',()=>({api:{POST:post},revokePreviousSessionForReplacement:(token:string)=>post('/auth/logout',{headers:{Authorization:`Bearer ${token}`},alert:false})}))
afterEach(()=>{window.localStorage.clear();post.mockReset()})
async function installer(){const path='@web/src/auth/session-install';const module=await import(/* @vite-ignore */path).catch(()=>undefined);expect(module).toBeDefined();return module!.installBrowserSession}
it('a storage replacement during old-session logout survives a late sign-in response',async()=>{
  const install=await installer();writeToken(window.localStorage,'old')
  const changes:Array<{token:string|null;source:string}>=[]
  const unsubscribe=subscribeSessionChanges((token,source)=>changes.push({token,source}))
  let done!:()=>void;post.mockReturnValue(new Promise<void>(resolve=>{done=resolve}))
  const installing=install('new',()=>true)
  writeToken(window.localStorage,'other-tab');done()
  expect(await installing).toMatchObject({status:'failed'})
  expect(readToken(window.localStorage)).toBe('other-tab')
  expect(changes).toEqual([{token:'other-tab',source:'write'}])
  unsubscribe()
})
it('clears only the revoked old token when sign-in is cancelled after logout succeeds',async()=>{
  const install=await installer();writeToken(window.localStorage,'old')
  const changes:Array<{token:string|null;source:string}>=[]
  const unsubscribe=subscribeSessionChanges((token,source)=>changes.push({token,source}))
  let done!:()=>void,current=true;post.mockReturnValue(new Promise<void>(resolve=>{done=resolve}))
  const installing=install('new',()=>current);current=false;done()
  expect(await installing).toEqual({status:'stale'})
  expect(readToken(window.localStorage)).toBeNull()
  expect(changes).toEqual([{token:null,source:'remove'}])
  unsubscribe()
})
