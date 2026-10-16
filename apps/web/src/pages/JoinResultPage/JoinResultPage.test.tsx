// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { JoinResultPage } from './index'
import { ExAxiosError } from '@workspace/sdk/http/browser'
import { writeToken, clearBrowserSession } from '@web/src/auth/storage'
const get = vi.hoisted(() => vi.fn())
vi.mock('@web/src/api/client', () => ({ api: { GET: get } }))
vi.mock('@web/src/join/CommunityAuthentication', () => ({ CommunityAuthentication: () => <p>登录表单</p> }))
beforeEach(() => writeToken(localStorage, 'owner'))
afterEach(() => { cleanup(); clearBrowserSession(); get.mockReset(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/') })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function setup() { render(<MemoryRouter><JoinResultPage /></MemoryRouter>); return userEvent.setup() }
function page(status: 'pending' | 'approved' | 'rejected' | null = 'pending', communityId = 'rifling-911') {
  return { items: [{ communityId, application: status ? { id: 'a', status, createdAt: 1, reviewedAt: null } : null, membership: status === 'approved' ? { applicationId: 'a', joinedAt: 2 } : null, requiredProviders: [], missingProviders: [], requirementsMet: true, websiteReady: status === 'approved' }], total: 1, limit: 20, offset: 0 }
}
it.each([['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝'], [null, '尚未申请']] as const)('renders own %s without inviting registration or email lookup', async (status, label) => {
  get.mockResolvedValue(page(status)); setup()
  expect(await screen.findByText(label)).toBeTruthy()
  expect(get).toHaveBeenCalledExactlyOnceWith('/auth/me/communities', expect.objectContaining({ headers: { Authorization: 'Bearer owner' }, params: { query: { limit: 20, offset: 0 } } }))
  expect(screen.queryByLabelText('申请邮箱')).toBeNull()
  expect(screen.queryByRole('link', { name: /注册/ })).toBeNull()
  if (status) expect(screen.getByText(/所有审核状态均不能重新申请/)).toBeTruthy()
})
it('requires a session before reading and clears old email/code parameters with an explanation', () => {
  clearBrowserSession(); window.history.replaceState({}, '', '/join/result?email=old@example.com&code=secret&keep=1'); setup()
  expect(get).not.toHaveBeenCalled(); expect(screen.getByText('登录表单')).toBeTruthy()
  expect(screen.getByText(/旧邮箱查询参数已清除/)).toBeTruthy()
  expect(window.location.search).toBe('?keep=1')
})
it('clears old owner data and ignores a late response after switching accounts', async () => {
  const old = deferred<ReturnType<typeof page>>()
  get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('approved', 'second'))
  setup(); act(() => writeToken(localStorage, 'second-owner'))
  expect(await screen.findByText('已通过')).toBeTruthy()
  await act(async () => old.resolve(page('pending', 'private-first')))
  expect(screen.queryByText('private-first')).toBeNull(); expect(screen.queryByText('待审核')).toBeNull()
  act(() => clearBrowserSession()); expect(screen.queryByText('已通过')).toBeNull()
})
it('discards an unmounted response and reloads current owner on a fresh mount', async () => {
  const old = deferred<ReturnType<typeof page>>()
  get.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('rejected'))
  setup(); cleanup(); setup()
  expect(await screen.findByText('已拒绝')).toBeTruthy()
  await act(async () => old.resolve(page('pending')))
  expect(screen.queryByText('待审核')).toBeNull(); expect(get).toHaveBeenCalledTimes(2)
})
it('reports rate limiting and private failures with an explicit retry', async () => {
  get.mockRejectedValueOnce(new ExAxiosError('http', 'HTTP_ERROR', 'private', { status: 429 })).mockRejectedValueOnce(new Error('private error')).mockResolvedValueOnce(page())
  const user = setup(); expect(await screen.findByText('查询过于频繁，请稍后再试')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '刷新本人状态' })); expect(await screen.findByText('无法读取本人社区状态，请重试')).toBeTruthy()
  expect(screen.queryByText('private error')).toBeNull()
  await user.click(screen.getByRole('button', { name: '刷新本人状态' })); expect(await screen.findByText('待审核')).toBeTruthy()
})
it('selects communities and paginates while clearing previous page data', async () => {
  const next = deferred<ReturnType<typeof page>>()
  get.mockResolvedValueOnce({ ...page(), total: 21, items: [...page().items, ...page('approved', 'another').items] }).mockReturnValueOnce(next.promise)
  const user = setup(); await screen.findByText('待审核')
  fireEvent.change(screen.getByLabelText('选择社区'), { target: { value: 'another' } }); expect(screen.getByText('已通过')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '下一页' })); expect(screen.queryByText('已通过')).toBeNull()
  expect(get).toHaveBeenLastCalledWith('/auth/me/communities', expect.objectContaining({ params: { query: { limit: 20, offset: 20 } } }))
  await act(async () => next.resolve({ ...page('rejected', 'last'), offset: 20, total: 21 }))
  expect(screen.getByText('已拒绝')).toBeTruthy()
})
