// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AuthProvider } from '@web/src/auth/AuthContext'
import { RootLayout } from '@web/src/routes/RootLayout'
import { ExMessage } from '@exre/exui'
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock('@web/src/api/client', () => ({ api: { POST: post, GET: get } }))
let mobile = false
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', TestResizeObserver)
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }))
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(ExMessage, 'info').mockReturnValue('info')
})
afterEach(() => { cleanup(); post.mockReset(); get.mockReset(); vi.restoreAllMocks(); mobile = false })
function renderLayout() { return render(<MemoryRouter><AuthProvider><Routes><Route element={<RootLayout />}><Route path="/" element={<p>首页</p>} /><Route path="/join/rifling-911" element={<h1>申请加入页面</h1>} /></Route></Routes></AuthProvider></MemoryRouter>) }

it.each([false, true])('preserves registration modal and restores its corresponding trigger for mobile=%s', async isMobile => {
  mobile = isMobile
  const user = userEvent.setup()
  renderLayout()
  const trigger = isMobile ? await screen.findByRole('combobox', { name: '用户菜单' }) : await screen.findByRole('button', { name: '注册' })
  if (isMobile) { trigger.focus(); await user.keyboard('[Space]'); await user.click(screen.getByRole('option', { name: '注册' })) }
  else await user.click(trigger)
  expect(await screen.findByRole('dialog', { name: '注册' })).toBeTruthy()
  expect(screen.queryByLabelText('密码')).toBeNull()
  await user.keyboard('[Escape]')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(post).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
})

it('switches the ordinary login dialog to public registration', async () => {
  const user = userEvent.setup()
  renderLayout()
  await user.click(await screen.findByRole('button', { name: '登录' }))
  await user.click(screen.getByRole('button', { name: '注册账号' }))
  expect(await screen.findByRole('dialog', { name: '注册' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '申请加入页面' })).toBeNull()
  expect(post).not.toHaveBeenCalled()
})

it('switches the same registration dialog to ordinary login with only the completed email', async () => {
  const user = userEvent.setup()
  post.mockResolvedValueOnce({ status:'accepted',challengeId:'10000000-0000-4000-8000-000000000001',serverTime:1000,resendAvailableAt:1000 }).mockResolvedValueOnce({ email:'member@example.com',registrationToken:'t'.repeat(43),expiresAt:Date.now()+1_800_000 }).mockResolvedValueOnce({ email:'member@example.com',status:'registered',userId:'20000000-0000-4000-8000-000000000001' })
  renderLayout()
  await user.click(await screen.findByRole('button', { name: '注册' }))
  const dialog = screen.getByRole('dialog')
  await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
  await user.click(screen.getByRole('button', { name: '继续' }))
  await user.type(await screen.findByLabelText('6 位验证码'), '001234')
  await user.type(await screen.findByLabelText('用户名'), '成员')
  await user.type(await screen.findByLabelText('密码'), 'password-one')
  await user.click(screen.getByRole('button', { name: '完成注册' }))
  await user.click(screen.getByRole('button', { name: '前往登录' }))
  expect(screen.getByRole('dialog', { name: '登录' })).toBe(dialog)
  expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('member@example.com')
  expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('')
  expect(post.mock.calls.map(([path]) => path)).toEqual(['/auth/registration/code', '/auth/registration/verify', '/auth/registrations'])
})
