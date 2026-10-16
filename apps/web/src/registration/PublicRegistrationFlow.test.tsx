// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,render,screen,waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MemoryRouter} from 'react-router'
import {ExMessage} from '@exre/exui'
import {StrictMode} from 'react'
import {act} from '@testing-library/react'
import {ExAxiosError} from '@workspace/sdk/http/browser'
import {AUTH_TOKEN_KEY,syncSessionToken} from '@web/src/auth/storage'
const api=vi.hoisted(()=>({POST:vi.fn(),GET:vi.fn(),DELETE:vi.fn()}))
vi.mock('@web/src/api/client',()=>({api,revokePreviousSessionForReplacement:(token:string)=>api.POST('/auth/logout',{headers:{Authorization:`Bearer ${token}`},alert:false})}))
class Resize {observe(){}unobserve(){}disconnect(){}}
vi.stubGlobal('ResizeObserver',Resize)
Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>document.body})
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();window.localStorage.clear();window.history.replaceState(null,'','/')})
async function component(){const path='@web/src/registration/PublicRegistrationFlow';const module=await import(/* @vite-ignore */path).catch(()=>undefined);expect(module).toBeDefined();return module!.PublicRegistrationFlow}
it('email registration sends, verifies and completes with a server grant and mandatory password',async()=>{
  const Flow=await component(),user=userEvent.setup()
  vi.spyOn(ExMessage,'info').mockReturnValue('info')
  api.POST.mockResolvedValueOnce({status:'accepted',challengeId:'10000000-0000-4000-8000-000000000001',serverTime:10,resendAvailableAt:60_010})
    .mockResolvedValueOnce({registrationToken:'t'.repeat(43),email:'member@example.com',expiresAt:Date.now()+1_800_000})
    .mockResolvedValueOnce({status:'registered',userId:'20000000-0000-4000-8000-000000000001',email:'member@example.com'})
  render(<MemoryRouter><Flow presentation="modal" initialEmail="member@example.com"/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'继续'}))
  await user.type(await screen.findByLabelText('6 位验证码'),'123456')
  await user.type(await screen.findByLabelText('用户名'),'Member')
  await user.click(screen.getByRole('button',{name:'完成注册'}))
  expect(api.POST).toHaveBeenCalledTimes(2)
  await user.type(screen.getByLabelText('密码'),'valid password')
  await user.click(screen.getByRole('button',{name:'完成注册'}))
  expect(await screen.findByRole('heading',{name:'注册成功'})).toBeTruthy()
  expect(api.POST.mock.calls.map(([path])=>path)).toEqual(['/auth/registration/code','/auth/registration/verify','/auth/registrations'])
  expect(api.POST.mock.calls[2]![1].body).toEqual({registrationToken:'t'.repeat(43),nickname:'Member',password:'valid password'})
})
it('retired invitation links discard code without verifying and reserved providers never send requests',async()=>{
  const Flow=await component()
  window.history.replaceState({keep:true},'','/register?email=member@example.com&code=123456')
  render(<MemoryRouter><Flow presentation="page"/></MemoryRouter>)
  await waitFor(()=>expect(window.location.search).not.toContain('code='))
  expect(screen.getByText(/注册流程已调整/)).toBeTruthy()
  expect((screen.getByRole('button',{name:'Google 暂未开放'}) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button',{name:'QQ 暂未开放'}) as HTMLButtonElement).disabled).toBe(true)
  expect(api.POST).not.toHaveBeenCalled()
})
const accepted={status:'accepted',challengeId:'10000000-0000-4000-8000-000000000001',serverTime:10,resendAvailableAt:10}
const grant={registrationToken:'t'.repeat(43),email:'member@example.com',expiresAt:Date.now()+1_800_000}
it('an existing mailbox cannot advance to a grant and instead hands off to ordinary login',async()=>{
  const Flow=await component(),user=userEvent.setup(),onLogin=vi.fn()
  api.POST.mockRejectedValue(new ExAxiosError('http','EMAIL_IN_USE','PRIVATE_VENDOR_MESSAGE',{status:409}))
  render(<MemoryRouter><Flow presentation="modal" initialEmail="existing@example.com" onLogin={onLogin}/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'继续'}))
  expect(await screen.findByText('该邮箱已有账号，请登录')).toBeTruthy()
  expect(screen.queryByLabelText('6 位验证码')).toBeNull();expect(screen.queryByLabelText('用户名')).toBeNull()
  expect(screen.queryByText(/请登录后再关联 Cfx|PRIVATE_VENDOR_MESSAGE/)).toBeNull()
  await user.click(screen.getByRole('button',{name:'已经有账号？登录'}))
  expect(onLogin).toHaveBeenCalledExactlyOnceWith('existing@example.com')
  expect(api.POST.mock.calls.map(([path])=>path)).toEqual(['/auth/registration/code'])
  expect(window.localStorage.length).toBe(0)
})
it.each(['REGISTRATION_CODE_RESEND_TOO_SOON','REGISTRATION_MAIL_UNAVAILABLE','NETWORK_ERROR'])('resend failure %s leaves the existing challenge verifiable and reports a form error',async code=>{
  const Flow=await component(),user=userEvent.setup()
  api.POST.mockResolvedValueOnce(accepted).mockRejectedValueOnce(new ExAxiosError('http',code,'safe',{status:429,retryAfterSeconds:60})).mockResolvedValueOnce(grant)
  render(<MemoryRouter><Flow presentation="modal" initialEmail="member@example.com"/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'继续'}))
  await user.click(await screen.findByRole('button',{name:'重新发送验证码'}))
  await waitFor(()=>expect(api.POST).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button',{name:'重试验证'})).toBeNull()
  expect(screen.queryByText(/验证暂时锁定/)).toBeNull()
  const input=screen.getByLabelText('6 位验证码') as HTMLInputElement
  expect(input.disabled).toBe(false);expect(input.getAttribute('aria-invalid')).toBe('false')
  await user.type(input,'001234')
  expect(await screen.findByLabelText('密码')).toBeTruthy()
  expect(api.POST.mock.calls[2]![1].body).toEqual({challengeId:accepted.challengeId,code:'001234'})
})
it('back ignores a late verification and a new email gets a new challenge instead of inheriting the grant',async()=>{
  const Flow=await component(),user=userEvent.setup();let resolve!:(value:typeof grant)=>void
  api.POST.mockResolvedValueOnce(accepted).mockReturnValueOnce(new Promise(done=>{resolve=done})).mockResolvedValueOnce({...accepted,challengeId:'20000000-0000-4000-8000-000000000001'})
  render(<MemoryRouter><Flow presentation="modal" initialEmail="member@example.com"/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'继续'}));await user.type(await screen.findByLabelText('6 位验证码'),'001234')
  await user.click(screen.getByRole('button',{name:'返回修改邮箱'}));await act(async()=>resolve(grant))
  expect(screen.queryByLabelText('密码')).toBeNull()
  await user.clear(screen.getByLabelText('邮箱'));await user.type(screen.getByLabelText('邮箱'),'other@example.com')
  await user.click(screen.getByRole('button',{name:'继续'}))
  expect(api.POST.mock.calls[2]![1].body).toEqual({email:'other@example.com'})
})
it('retains leading zeros and only retries failed verification on an explicit action',async()=>{
  const Flow=await component(),user=userEvent.setup()
  api.POST.mockResolvedValueOnce(accepted).mockRejectedValueOnce(new ExAxiosError('http','REGISTRATION_CODE_INVALID','safe',{status:400})).mockResolvedValueOnce(grant)
  render(<MemoryRouter><Flow presentation="modal" initialEmail="member@example.com"/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'继续'}));const code=await screen.findByLabelText('6 位验证码') as HTMLInputElement
  await user.type(code,'001234');expect(await screen.findAllByText('验证码无效或已过期')).toHaveLength(1)
  expect(code.value).toBe('001234');expect(api.POST).toHaveBeenCalledTimes(2)
  await user.click(screen.getByRole('button',{name:'重试验证'}));expect(await screen.findByLabelText('密码')).toBeTruthy()
  expect(api.POST.mock.calls[2]![1].body.code).toBe('001234')
})
it('Cfx profile completion survives StrictMode, keeps email immutable and performs no mailbox verification',async()=>{
  const Flow=await component(),user=userEvent.setup();vi.spyOn(ExMessage,'info').mockReturnValue('info')
  api.POST.mockResolvedValue({status:'registered',userId:'20000000-0000-4000-8000-000000000001',email:grant.email})
  render(<StrictMode><MemoryRouter><Flow presentation="modal" initialGrant={{kind:'registration-required',...grant,suggestedNickname:'CfxMember'}}/></MemoryRouter></StrictMode>)
  expect(screen.queryByLabelText('邮箱')).toBeNull();expect(screen.getByText(grant.email)).toBeTruthy()
  await user.type(screen.getByLabelText('密码'),'valid password');await user.click(screen.getByRole('button',{name:'完成注册'}))
  expect(await screen.findByRole('heading',{name:'注册成功'})).toBeTruthy()
  expect(api.POST).toHaveBeenCalledTimes(1);expect(api.POST.mock.calls[0]![0]).toBe('/auth/registrations')
  expect(api.POST.mock.calls[0]![1].body).toEqual({registrationToken:grant.registrationToken,nickname:'CfxMember',password:'valid password'})
  expect(window.localStorage.length).toBe(0)
})
it('drops an initial Cfx grant and its profile when another tab changes the session owner',async()=>{
  const Flow=await component()
  render(<MemoryRouter><Flow presentation="page" initialGrant={{kind:'registration-required',...grant,suggestedNickname:'Old'}}/></MemoryRouter>)
  expect(screen.getByLabelText('密码')).toBeTruthy()
  await act(async()=>{window.localStorage.setItem(AUTH_TOKEN_KEY,'other-owner');syncSessionToken('storage')})
  expect(screen.queryByLabelText('密码')).toBeNull()
  expect(screen.getByRole('button',{name:'继续'})).toBeTruthy()
  expect(api.POST).not.toHaveBeenCalled()
})
it('closing after completion cancels the automatic login timer and cannot reopen the closed modal',async()=>{
  const Flow=await component(),user=userEvent.setup(),onLogin=vi.fn();vi.spyOn(ExMessage,'info').mockReturnValue('info')
  api.POST.mockResolvedValue({status:'registered',userId:'20000000-0000-4000-8000-000000000001',email:grant.email})
  const view=render(<MemoryRouter><Flow presentation="modal" initialGrant={{kind:'registration-required',...grant,suggestedNickname:'CfxMember'}} onLogin={onLogin}/></MemoryRouter>)
  await user.type(screen.getByLabelText('密码'),'valid password');await user.click(screen.getByRole('button',{name:'完成注册'}))
  expect(await screen.findByRole('heading',{name:'注册成功'})).toBeTruthy()
  view.unmount();await new Promise(resolve=>setTimeout(resolve,1600));expect(onLogin).not.toHaveBeenCalled()
})

it.each([
  {result:{kind:'account-exists',email:'existing@example.com',nextAction:'login_then_link'},expected:'该邮箱已有账号，请登录后在设置中主动关联 Cfx。'},
  {result:{kind:'signed-in',token:'new-token',expiresAt:Date.now()+600_000},expected:'new-token'},
])('routes a $result.kind Cfx result through public registration',async ({result,expected})=>{
  const Flow=await component(),user=userEvent.setup(),onSessionCreated=vi.fn()
  api.POST.mockImplementation((path:string)=>Promise.resolve(path==='/auth/cfx/attempts'
    ? {attemptId:'a'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000}
    : path.endsWith('/complete')?{state:'ready'}:result))
  api.GET.mockResolvedValue({state:'ready',attemptId:'a'.repeat(43),identityTicket:'t'.repeat(43),ticketExpiresAt:Date.now()+30_000})
  render(<MemoryRouter><Flow presentation="modal" onSessionCreated={onSessionCreated}/></MemoryRouter>)
  await user.click(screen.getByRole('button',{name:'使用 Cfx'}))
  await user.type(await screen.findByLabelText('加密授权结果'),'encrypted')
  await user.click(screen.getByRole('button',{name:'完成 Cfx 授权'}))
  if(result.kind==='signed-in'){
    await waitFor(()=>expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith(expected))
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe(expected)
  }else{
    expect(await screen.findByText(expected)).toBeTruthy()
    expect(onSessionCreated).not.toHaveBeenCalled()
  }
})
