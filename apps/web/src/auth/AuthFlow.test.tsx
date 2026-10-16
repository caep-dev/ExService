// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { ExAxiosError } from '@workspace/sdk/http/browser'
import {ExMessage} from '@exre/exui'

const post = vi.hoisted(() => vi.fn())
const get = vi.hoisted(() => vi.fn())
const del = vi.hoisted(() => vi.fn())
vi.mock('@web/src/api/client', () => ({ api: { POST: post, GET:get, DELETE:del }, revokePreviousSessionForReplacement: (token: string) => post('/auth/logout', { headers: { Authorization: `Bearer ${token}` }, alert: false }) }))
vi.mock('@web/src/pages/AuthPage/AuthBackdrop', () => ({ AuthBackdrop: () => null }))

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })

import { AuthFlow } from '@web/src/auth/AuthFlow'
import { AuthPage } from '@web/src/pages/AuthPage'
import { CommunityAuthentication } from '@web/src/join/CommunityAuthentication'
import { AUTH_TOKEN_KEY, syncSessionToken } from '@web/src/auth/storage'

afterEach(() => { cleanup(); post.mockReset(); get.mockReset(); del.mockReset(); window.localStorage.clear() })

describe('AuthFlow captcha stage', () => {
  it('drops an already displayed Cfx registration grant when another tab changes the session owner', async () => {
    const user=userEvent.setup()
    post.mockImplementation((path:string)=>Promise.resolve(path==='/auth/cfx/attempts'
      ? {attemptId:'a'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000}
      : path.endsWith('/complete')?{state:'ready'}
      : {kind:'registration-required',registrationToken:'g'.repeat(43),email:'old@example.com',suggestedNickname:'Old',expiresAt:Date.now()+300_000}))
    get.mockResolvedValue({state:'ready',attemptId:'a'.repeat(43),identityTicket:'t'.repeat(43),ticketExpiresAt:Date.now()+30_000})
    render(<MemoryRouter><AuthFlow presentation="modal"/></MemoryRouter>)
    await user.click(screen.getByRole('button',{name:'使用 Cfx'}))
    await user.type(await screen.findByLabelText('加密授权结果'),'encrypted')
    await user.click(screen.getByRole('button',{name:'完成 Cfx 授权'}))
    expect(await screen.findByLabelText('密码')).toBeTruthy()
    await act(async()=>{window.localStorage.setItem(AUTH_TOKEN_KEY,'other-owner');syncSessionToken('storage')})
    expect(screen.queryByRole('button',{name:'完成注册'})).toBeNull()
    expect(screen.getByRole('button',{name:'继续'})).toBeTruthy()
    expect(post.mock.calls.some(([path])=>path==='/auth/registrations')).toBe(false)
  })
  it('discards an unfinished Cfx authorization after the owner changes', async () => {
    const user=userEvent.setup();let finishAttempt!:(value:unknown)=>void
    post.mockImplementation(path=>path==='/auth/cfx/attempts'?new Promise(resolve=>{finishAttempt=resolve}):Promise.resolve({state:'ready'}))
    del.mockResolvedValue({state:'cancelled'})
    render(<MemoryRouter><AuthFlow presentation="modal"/></MemoryRouter>)
    await user.click(screen.getByRole('button',{name:'使用 Cfx'}))
    await waitFor(()=>expect(finishAttempt).toBeDefined())
    await act(async()=>{window.localStorage.setItem(AUTH_TOKEN_KEY,'other-owner');syncSessionToken('storage')})
    await act(async()=>{finishAttempt({attemptId:'a'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000})})
    expect(screen.queryByLabelText('加密授权结果')).toBeNull()
    expect(screen.getByRole('button',{name:'使用 Cfx'})).toBeTruthy()
    await waitFor(()=>expect(del).toHaveBeenCalledOnce())
  })
  it('completes a second Cfx sign-in once after returning from a nested registration grant', async () => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    let exchanges = 0
    post.mockImplementation((path: string) => Promise.resolve(
      path === '/auth/cfx/attempts'
        ? { attemptId: 'a'.repeat(43), mode: 'manual', authorizationUrl: 'https://forum.cfx.re/user-api-key/new', expiresAt: Date.now() + 600_000 }
        : path.endsWith('/complete') ? { state: 'ready' }
          : path === '/auth/cfx/sign-in' && ++exchanges === 1
            ? { kind: 'registration-required', registrationToken: 'g'.repeat(43), email: 'member@example.com', suggestedNickname: 'Member', expiresAt: Date.now() + 300_000 }
            : { kind: 'signed-in', token: 'new-token', expiresAt: Date.now() + 600_000 },
    ))
    get.mockResolvedValue({ state: 'ready', attemptId: 'a'.repeat(43), identityTicket: 't'.repeat(43), ticketExpiresAt: Date.now() + 30_000 })
    render(<MemoryRouter><AuthFlow presentation="modal" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(screen.getByRole('button', { name: '使用 Cfx' }))
      await user.type(await screen.findByLabelText('加密授权结果'), 'encrypted')
      await user.click(screen.getByRole('button', { name: '完成 Cfx 授权' }))
      if (attempt === 0) {
        await screen.findByRole('button', { name: '完成注册' })
        await user.click(screen.getByRole('button', { name: '返回修改邮箱' }))
      }
    }
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledOnce())
    expect(onSessionCreated).toHaveBeenCalledWith('new-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
  })
  it('unlocks ordinary login after finishing a Cfx registration in the same modal',async()=>{
    const user=userEvent.setup();vi.spyOn(ExMessage,'info').mockReturnValue('info')
    post.mockImplementation((path:string)=>Promise.resolve(path==='/auth/cfx/attempts'?{attemptId:'a'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000}:path==='/auth/cfx/sign-in'?{kind:'registration-required',registrationToken:'t'.repeat(43),email:'cfx@example.com',suggestedNickname:'Member',expiresAt:Date.now()+300_000}:path==='/auth/registrations'?{status:'registered',email:'cfx@example.com',userId:'10000000-0000-4000-8000-000000000001'}:{state:'ready'}))
    get.mockResolvedValue({state:'ready',attemptId:'a'.repeat(43),identityTicket:'t'.repeat(43),ticketExpiresAt:Date.now()+30_000})
    render(<MemoryRouter><AuthFlow presentation="modal"/></MemoryRouter>)
    await user.click(screen.getByRole('button',{name:'使用 Cfx'}));await user.type(await screen.findByLabelText('加密授权结果'),'encrypted');await user.click(screen.getByRole('button',{name:'完成 Cfx 授权'}))
    await user.type(await screen.findByLabelText('密码'),'valid password');await user.click(screen.getByRole('button',{name:'完成注册'}))
    await user.click(await screen.findByRole('button',{name:'前往登录'}))
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('cfx@example.com')
    expect((screen.getByLabelText('密码') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByRole('button',{name:'继续'}) as HTMLButtonElement).disabled).toBe(false)
  })
  it('keeps password login disabled until Cfx finishes revoking the previous session and installing the new one',async()=>{
    const user=userEvent.setup(),onSessionCreated=vi.fn();let finishLogout!:(value:unknown)=>void
    window.localStorage.setItem(AUTH_TOKEN_KEY,'old-token')
    post.mockImplementation((path:string)=>{
      if(path==='/auth/cfx/attempts')return Promise.resolve({attemptId:'a'.repeat(43),mode:'manual',authorizationUrl:'https://forum.cfx.re/user-api-key/new',expiresAt:Date.now()+600_000})
      if(path.endsWith('/complete'))return Promise.resolve({state:'ready'})
      if(path==='/auth/cfx/sign-in')return Promise.resolve({kind:'signed-in',token:'new-token',expiresAt:Date.now()+600_000})
      if(path==='/auth/logout')return new Promise(resolve=>{finishLogout=resolve})
      throw new Error('unexpected password request')
    })
    get.mockResolvedValue({state:'ready',attemptId:'a'.repeat(43),identityTicket:'t'.repeat(43),ticketExpiresAt:Date.now()+30_000})
    render(<MemoryRouter><AuthFlow presentation="modal" onSessionCreated={onSessionCreated}/></MemoryRouter>)
    await user.click(screen.getByRole('button',{name:'使用 Cfx'}))
    await user.type(await screen.findByLabelText('加密授权结果'),'encrypted')
    await user.click(screen.getByRole('button',{name:'完成 Cfx 授权'}))
    await waitFor(()=>expect(finishLogout).toBeDefined())
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).disabled).toBe(true)
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('old-token')
    finishLogout({status:'ok'})
    await waitFor(()=>expect(onSessionCreated).toHaveBeenCalledWith('new-token'))
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
    expect(post.mock.calls.some(([path])=>path==='/auth/login')).toBe(false)
  })
  it('clears a revoked old session when Cfx is cancelled during successful logout', async () => {
    const user = userEvent.setup(), onSessionCreated = vi.fn()
    let finishLogout!: (value: unknown) => void
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation((path: string) => {
      if (path === '/auth/cfx/attempts') return Promise.resolve({ attemptId: 'a'.repeat(43), mode: 'manual', authorizationUrl: 'https://forum.cfx.re/user-api-key/new', expiresAt: Date.now() + 600_000 })
      if (path.endsWith('/complete')) return Promise.resolve({ state: 'ready' })
      if (path === '/auth/cfx/sign-in') return Promise.resolve({ kind: 'signed-in', token: 'new-token', expiresAt: Date.now() + 600_000 })
      if (path === '/auth/logout') return new Promise(resolve => { finishLogout = resolve })
      throw new Error('unexpected request')
    })
    get.mockResolvedValue({ state: 'ready', attemptId: 'a'.repeat(43), identityTicket: 't'.repeat(43), ticketExpiresAt: Date.now() + 30_000 })
    del.mockResolvedValue({ state: 'cancelled' })
    render(<MemoryRouter><AuthFlow presentation="modal" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: '使用 Cfx' }))
    await user.type(await screen.findByLabelText('加密授权结果'), 'encrypted')
    await user.click(screen.getByRole('button', { name: '完成 Cfx 授权' }))
    await waitFor(() => expect(finishLogout).toBeDefined())
    await user.click(screen.getByRole('button', { name: '取消 Cfx 授权' }))
    await act(async () => { finishLogout({ status: 'ok' }) })
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '使用 Cfx' })).toBeTruthy()
  })
  it('ordinary login exposes Cfx while SSO exposes no executable third-party sign-in', async () => {
    const view=render(<MemoryRouter><AuthFlow presentation="modal"/></MemoryRouter>)
    expect(screen.getByRole('button',{name:'使用 Cfx'})).toBeTruthy()
    expect((screen.getByRole('button',{name:'Google 暂未开放'}) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    post.mockResolvedValue({ssoRequestId:'s'.repeat(43),status:'pending'})
    render(<MemoryRouter><AuthFlow presentation="page" ssoRequestId={'s'.repeat(43)}/></MemoryRouter>)
    await screen.findByRole('button',{name:'继续'})
    expect(screen.queryByRole('button',{name:'使用 Cfx'})).toBeNull()
  })
  it('removes the legal footer from the actual login page after continuing', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/login']}><AuthPage mode="login" /></MemoryRouter>)
    expect(screen.getByText('By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.')).toBeTruthy()

    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(screen.getByRole('heading', { name: '输入验证码' })).toBeTruthy()
    expect(screen.queryByText('By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.')).toBeNull()
  })

  it('submits ordinary login only after the placeholder step, without a captcha credential', async () => {
    const user = userEvent.setup()
    post.mockRejectedValue(new ExAxiosError('http', 'INVALID_CREDENTIALS', 'Invalid credentials', { status: 401 }))
    render(<MemoryRouter><AuthFlow initialMode="login" presentation="page"
      footer={<p>By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.</p>} /></MemoryRouter>)

    expect(screen.getByText('By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.')).toBeTruthy()

    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
    expect(screen.queryByText('By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.')).toBeNull()

    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(post).toHaveBeenCalledWith('/auth/login', {
      body: { email: 'member@example.com', password: 'password-one' },
      alert: false,
    })
    expect(await screen.findByText('邮箱或密码错误')).toBeTruthy()

    expect(screen.queryByRole('button', { name: '返回修改资料' })).toBeNull()
  })

  it('uses the same captcha step before SSO password login', async () => {
    const user = userEvent.setup()
    window.localStorage.clear()
    const ssoRequestId = 's'.repeat(43)
    post.mockImplementation((path: string) => path === '/auth/sso/inspect'
      ? Promise.resolve({ ssoRequestId, status: 'pending' })
      : Promise.reject(new ExAxiosError('http', 'INVALID_CREDENTIALS', 'Invalid credentials', { status: 401 })))
    render(<MemoryRouter><AuthFlow initialMode="login" presentation="page" ssoRequestId={ssoRequestId} /></MemoryRouter>)

    await screen.findByRole('button', { name: '继续' })
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(post).not.toHaveBeenCalledWith('/auth/sso/login', expect.anything())
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(post).toHaveBeenCalledWith('/auth/sso/login', {
      body: { ssoRequestId, email: 'member@example.com', password: 'password-one' },
      alert: false,
    })
  })

  it.each(['server rejection', 'network failure'])('keeps the existing session when account-switch logout has a %s', async failure => {
    const user = userEvent.setup()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation((path: string) => path === '/auth/login'
      ? Promise.resolve({ token: 'new-token' })
      : failure === 'network failure'
        ? Promise.reject(new Error('offline'))
        : Promise.reject(new ExAxiosError('http', 'SERVICE_UNAVAILABLE', 'Could not revoke', { status: 503 })))
    render(<MemoryRouter><AuthFlow presentation="page" /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(post).toHaveBeenCalledWith('/auth/logout', { headers: { Authorization: 'Bearer old-token' }, alert: false })
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('old-token')
    expect(await screen.findByText(/旧账号退出失败/)).toBeTruthy()
  })

  it('stores a new account token only after the old session has been revoked', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    let completeLogout: ((value: unknown) => void) | undefined
    post.mockImplementation((path: string) => path === '/auth/login'
      ? Promise.resolve({ token: 'new-token' })
      : new Promise(resolve => { completeLogout = resolve }))
    render(<MemoryRouter><AuthFlow presentation="page" /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(completeLogout).toBeDefined())
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('old-token')
    completeLogout?.({ status: 'ok' })
    await waitFor(() => expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token'))
  })

  it('keeps a successful Website login in its OIDC challenge flow', async () => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    post.mockResolvedValue({ token: 'new-token' })
    render(<MemoryRouter><AuthFlow presentation="page" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(onSessionCreated).toHaveBeenCalledWith('new-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
  })

  it.each([false, true])('accepts a new login after the old session expires (transport cleared it: %s)', async cleared => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation(async (path: string) => {
      if (path === '/auth/login') return { token: 'new-token' }
      if (cleared) { window.localStorage.removeItem(AUTH_TOKEN_KEY); syncSessionToken('http') }
      throw new ExAxiosError('http', 'SESSION_INVALID', 'Invalid session', { status: 401 })
    })
    render(<MemoryRouter><AuthFlow presentation="page" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(onSessionCreated).toHaveBeenCalledWith('new-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
  })

  it('finishes password login when transport clears an expired old session before login responds', async () => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation(async (path: string) => {
      if (path === '/auth/login') {
        window.localStorage.removeItem(AUTH_TOKEN_KEY)
        syncSessionToken('http')
        return { token: 'new-token' }
      }
      return { status: 'ok' }
    })
    render(<MemoryRouter><AuthFlow presentation="page" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(onSessionCreated).toHaveBeenCalledWith('new-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
  })

  it('calls the join modal continuation once after replacing an expired old session', async () => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation(async (path: string) => {
      if (path === '/auth/login') return { token: 'new-token' }
      window.localStorage.removeItem(AUTH_TOKEN_KEY)
      syncSessionToken('http')
      throw new ExAxiosError('http', 'SESSION_INVALID', 'Invalid session', { status: 401 })
    })
    render(<MemoryRouter><CommunityAuthentication onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledOnce())
    expect(onSessionCreated).toHaveBeenCalledWith('new-token')
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
  })

  it('preserves a replacement session arriving while the old account is being revoked', async () => {
    const user = userEvent.setup()
    const onSessionCreated = vi.fn()
    window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
    post.mockImplementation(async (path: string) => {
      if (path === '/auth/login') return { token: 'new-token' }
      window.localStorage.setItem(AUTH_TOKEN_KEY, 'replacement-token')
      return { status: 'ok' }
    })
    render(<MemoryRouter><AuthFlow presentation="page" onSessionCreated={onSessionCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText(/登录状态已在其他页面更改/)).toBeTruthy()
    expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('replacement-token')
    expect(onSessionCreated).not.toHaveBeenCalled()
  })
})
