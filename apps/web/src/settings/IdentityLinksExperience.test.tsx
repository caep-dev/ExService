// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,render,screen,waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ExAxiosError} from '@workspace/sdk/http/browser'
const api=vi.hoisted(()=>({GET:vi.fn(),POST:vi.fn(),DELETE:vi.fn()}))
vi.mock('@web/src/api/client',()=>({api}))
afterEach(()=>{cleanup();vi.resetAllMocks()})
beforeEach(()=>{api.DELETE.mockResolvedValue({state:'cancelled'})})
class Resize {observe(){}unobserve(){}disconnect(){}}
vi.stubGlobal('ResizeObserver',Resize)
const link={id:'10000000-0000-4000-8000-000000000001',provider:'cfx',externalUserId:'123',externalUsername:'Member',providerEmail:'other@example.com',linkedAt:1_800_000_000_000}
const response={providers:[{provider:'cfx',available:false,link},{provider:'google',available:false,link:null},{provider:'qq',available:false,link:null}]}
async function component(){const path='@web/src/settings/IdentityLinksExperience';return (await import(/* @vite-ignore */path)).IdentityLinksExperience}
it('shows disabled existing Cfx links and requires confirmation with community impact before unlinking',async()=>{
  const Component=await component(),user=userEvent.setup()
  api.GET.mockImplementation(path=>Promise.resolve(path==='/auth/me/identity-links'?response:{items:[{communityId:'rifling-911',membership:{joinedAt:1},requiredProviders:['cfx']}],total:1,offset:0,limit:50}))
  api.DELETE.mockResolvedValue({status:'unlinked',provider:'cfx'})
  render(<Component token={'a'.repeat(43)}/>)
  expect(await screen.findByText('Member')).toBeTruthy()
  expect((screen.getByRole('button',{name:'Google 暂未开放'}) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button',{name:'解除 Cfx 关联'}))
  expect(screen.getByText(/rifling-911/)).toBeTruthy();expect(api.DELETE).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button',{name:'确认解除关联'}))
  await waitFor(()=>expect(api.DELETE).toHaveBeenCalledWith('/auth/me/identity-links/cfx',expect.objectContaining({headers:{Authorization:`Bearer ${'a'.repeat(43)}`}})))
})
it('ignores a prior account response after the owner changes',async()=>{
  const Component=await component();let resolve!:(value:typeof response)=>void
  api.GET.mockImplementation((path,options)=>path==='/auth/me/identity-links'&&options.headers.Authorization===`Bearer ${'a'.repeat(43)}`?new Promise(done=>{resolve=done}):Promise.resolve(path==='/auth/me/identity-links'?{providers:response.providers.map(item=>({...item,link:null}))}:{items:[],total:0}))
  const view=render(<Component token={'a'.repeat(43)}/>);view.rerender(<Component token={'b'.repeat(43)}/>)
  await waitFor(()=>expect(screen.getByText('Cfx 暂未开放')).toBeTruthy());resolve(response)
  await waitFor(()=>expect(screen.queryByText('Member')).toBeNull())
})
it('keeps links and unlink available when community impact lookup fails, with an explicit unknown-impact warning',async()=>{
  const Component=await component(),user=userEvent.setup()
  api.GET.mockImplementation(path=>path==='/auth/me/identity-links'?Promise.resolve(response):Promise.reject(new Error('offline')))
  render(<Component token={'a'.repeat(43)}/>)
  expect(await screen.findByText('Member')).toBeTruthy()
  await user.click(screen.getByRole('button',{name:'解除 Cfx 关联'}))
  expect(screen.getByText(/暂时无法读取社区影响/)).toBeTruthy()
  expect((screen.getByRole('button',{name:'确认解除关联'}) as HTMLButtonElement).disabled).toBe(false)
})
it('warns about unconfirmed community impact while the lookup is still pending',async()=>{
  const Component=await component(),user=userEvent.setup()
  api.GET.mockImplementation(path=>path==='/auth/me/identity-links'?Promise.resolve(response):new Promise(()=>{}))
  render(<Component token={'a'.repeat(43)}/>)
  await user.click(await screen.findByRole('button',{name:'解除 Cfx 关联'}))
  expect(screen.getByText(/正在读取社区影响/)).toBeTruthy()
  expect(screen.getByText(/解除后须重新关联/)).toBeTruthy()
})
it.each(['response lost','conflict'])('reconciles the persisted link after %s and safely explains conflicts',async outcome=>{
  const Component=await component(),user=userEvent.setup();let committed=false
  const unlinked={providers:response.providers.map(item=>({...item,available:item.provider==='cfx',link:null}))}
  api.GET.mockImplementation(path=>Promise.resolve(path==='/auth/me/identity-links'?committed?response:unlinked:path==='/auth/me/communities'?{items:[],total:0}:{state:'ready',attemptId:'b'.repeat(43),identityTicket:'t'.repeat(43),ticketExpiresAt:Date.now()+30_000}))
  api.POST.mockImplementation(path=>{
    if(path==='/auth/me/identity-links/cfx/attempts')return Promise.resolve({attemptId:'b'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000})
    if(path.endsWith('/complete'))return Promise.resolve({state:'ready'})
    committed=outcome==='response lost'
    return Promise.reject(outcome==='conflict'?new ExAxiosError('http','IDENTITY_LINK_CONFLICT','safe',{status:409}):new Error('offline'))
  })
  render(<Component token={'a'.repeat(43)}/>)
  await user.click(await screen.findByRole('button',{name:'使用 Cfx'}))
  await user.type(await screen.findByLabelText('加密授权结果'),'encrypted')
  await user.click(screen.getByRole('button',{name:'完成 Cfx 授权'}))
  if(committed||outcome==='response lost')expect(await screen.findByText('Member')).toBeTruthy()
  else expect(await screen.findByText(/Cfx 身份已有其他关联/)).toBeTruthy()
  expect(api.GET.mock.calls.filter(([path])=>path==='/auth/me/identity-links')).toHaveLength(2)
})

it('matches a linked provider from shuffled input and reconciles a lost unlink response', async () => {
  const Component=await component(),user=userEvent.setup();let removed=false
  api.GET.mockImplementation(path=>Promise.resolve(path==='/auth/me/identity-links'
    ? {providers:[response.providers[2],response.providers[1],{...response.providers[0],link:removed?null:link}]}
    : {items:[{communityId:'history-community',membership:{joinedAt:1},requiredProviders:['cfx']}],total:1,offset:0,limit:50}))
  api.DELETE.mockImplementation(()=>{removed=true;return Promise.reject(new Error('response lost'))})
  render(<Component token={'a'.repeat(43)}/>)
  expect(await screen.findByText('Cfx ID：123')).toBeTruthy()
  await user.click(screen.getByRole('button',{name:'解除 Cfx 关联'}))
  expect(screen.getByText(/history-community/)).toBeTruthy()
  await user.click(screen.getByRole('button',{name:'确认解除关联'}))
  await waitFor(()=>expect(screen.queryByText('Cfx ID：123')).toBeNull())
  expect(api.GET.mock.calls.filter(([path])=>path==='/auth/me/identity-links')).toHaveLength(2)
  expect(api.DELETE).toHaveBeenCalledOnce()
})

it('keeps unlink locked and the old link visible until the readback settles', async () => {
  const Component=await component(),user=userEvent.setup();let confirmRead!:(value:unknown)=>void
  let reads=0
  api.GET.mockImplementation(path=>path==='/auth/me/identity-links'
    ? ++reads===1?Promise.resolve(response):new Promise(resolve=>{confirmRead=resolve})
    : Promise.resolve({items:[],total:0,offset:0,limit:50}))
  render(<Component token={'a'.repeat(43)}/>)
  await user.click(await screen.findByRole('button',{name:'解除 Cfx 关联'}))
  await user.click(screen.getByRole('button',{name:'确认解除关联'}))
  await waitFor(()=>expect(reads).toBe(2))
  expect(screen.getByText('Cfx ID：123')).toBeTruthy()
  expect((screen.getByRole('button',{name:'确认解除关联'}) as HTMLButtonElement).disabled).toBe(true)
  confirmRead({providers:response.providers.map(item=>item.provider==='cfx'?{...item,link:null}:item)})
  await waitFor(()=>expect(screen.queryByText('Cfx ID：123')).toBeNull())
})

it('does not read back or display a former owner after an in-flight unlink and account switch', async () => {
  const Component=await component(),user=userEvent.setup();let finishDelete!:(value:unknown)=>void
  api.GET.mockImplementation((path,options)=>Promise.resolve(path==='/auth/me/identity-links'
    ? options.headers.Authorization===`Bearer ${'a'.repeat(43)}`?response:{providers:response.providers.map(item=>({...item,link:null}))}
    : {items:[],total:0,offset:0,limit:50}))
  api.DELETE.mockImplementation(()=>new Promise(resolve=>{finishDelete=resolve}))
  const view=render(<Component token={'a'.repeat(43)}/>)
  await user.click(await screen.findByRole('button',{name:'解除 Cfx 关联'}))
  await user.click(screen.getByRole('button',{name:'确认解除关联'}))
  await waitFor(()=>expect(finishDelete).toBeDefined())
  view.rerender(<Component token={'b'.repeat(43)}/>)
  await waitFor(()=>expect(screen.queryByText('Cfx ID：123')).toBeNull())
  finishDelete({status:'unlinked'})
  await waitFor(()=>expect(api.GET.mock.calls.filter(([path])=>path==='/auth/me/identity-links')).toHaveLength(2))
  expect(screen.queryByText('Cfx ID：123')).toBeNull()
})

it('blocks another unlink while the first result is unknown until an explicit read succeeds', async () => {
  const Component=await component(),user=userEvent.setup();let reads=0
  api.GET.mockImplementation(path=>path==='/auth/me/identity-links'
    ? ++reads===2?Promise.reject(new Error('offline')):Promise.resolve(response)
    : Promise.resolve({items:[],total:0,offset:0,limit:50}))
  api.DELETE.mockRejectedValue(new Error('response lost'))
  render(<Component token={'a'.repeat(43)}/>)
  await user.click(await screen.findByRole('button',{name:'解除 Cfx 关联'}))
  await user.click(screen.getByRole('button',{name:'确认解除关联'}))
  expect(await screen.findByText('关联结果暂时无法确认，请重新读取关联账户')).toBeTruthy()
  expect((screen.getByRole('button',{name:'确认解除关联'}) as HTMLButtonElement).disabled).toBe(true)
  expect(api.DELETE).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button',{name:'重新读取关联账户'}))
  await waitFor(()=>expect(reads).toBe(3))
  expect((await screen.findByRole('button',{name:'解除 Cfx 关联'}) as HTMLButtonElement).disabled).toBe(false)
  expect(api.DELETE).toHaveBeenCalledOnce()
})
