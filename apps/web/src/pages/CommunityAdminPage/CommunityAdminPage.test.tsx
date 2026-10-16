// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ExMessage } from '@exre/exui'
import { waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { writeToken, clearBrowserSession } from '@web/src/auth/storage'
import { CommunityAdminPage } from './index'
const { get, post, put, remove } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), remove: vi.fn() }))
vi.mock('@web/src/api/client', () => ({ api: { GET: get, POST: post, PUT: put, DELETE: remove } }))
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
afterEach(() => { cleanup(); clearBrowserSession(); vi.resetAllMocks(); vi.restoreAllMocks() })
it('does not read admin data without server platform permission', async () => {
  writeToken(localStorage, 'ordinary')
  get.mockResolvedValue({ isPlatformAdmin: false, communities: [{ id: 'rifling-911', displayName: 'Rifling 911', requiresCfx: true, configRevision: 0 }] })
  render(<MemoryRouter><CommunityAdminPage /></MemoryRouter>)
  expect(await screen.findByText('当前账号没有平台管理权限。')).toBeTruthy()
  expect(get.mock.calls.map(call => call[0])).toEqual(['/auth/me/review-access'])
  expect(screen.queryByRole('button', { name: '保存社区' })).toBeNull()
})
it('paginates reviewers and grants/revokes the chosen UUID within the community scope', async () => {
  const id = '22222222-2222-4222-8222-222222222222'
  writeToken(localStorage, 'admin')
  vi.spyOn(ExMessage, 'info').mockReturnValue('info')
  get.mockImplementation((path: string) => Promise.resolve(path === '/auth/me/review-access' ? { isPlatformAdmin: true, communities: [] } : path === '/communities' ? { items: [{ id: 'rifling-911', displayName: 'Rifling 911', requiresCfx: false, configRevision: 0 }], total: 1, limit: 20, offset: 0 } : { items: [{ userId: id, nickname: '审核员', grantedByUserId: id, grantedAt: 1 }], total: 21, limit: 20, offset: 0 }))
  put.mockResolvedValue({ userId: id }); remove.mockResolvedValue({ status: 'revoked' })
  render(<MemoryRouter><CommunityAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '管理 Rifling 911' }))
  await screen.findByRole('button', { name: '撤销 审核员' })
  fireEvent.click(screen.getByRole('button', { name: '下一页审核员' }))
  await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/communities/{communityId}/reviewers', expect.objectContaining({ params: { path: { communityId: 'rifling-911' }, query: { limit: 20, offset: 20 } }, headers: { Authorization: 'Bearer admin' } })))
  fireEvent.change(screen.getByLabelText('审核员账号 UUID'), { target: { value: id } })
  await waitFor(() => expect((screen.getByRole('button', { name: '授予审核权限' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '授予审核权限' }))
  await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/communities/{communityId}/reviewers/{userId}', expect.objectContaining({ params: { path: { communityId: 'rifling-911', userId: id } }, body: {}, headers: { Authorization: 'Bearer admin' } })))
  await waitFor(() => expect((screen.getByRole('button', { name: '撤销 审核员' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '撤销 审核员' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/admin/communities/{communityId}/reviewers/{userId}', expect.objectContaining({ params: { path: { communityId: 'rifling-911', userId: id } }, headers: { Authorization: 'Bearer admin' } })))
})
it('submits revision and owner headers when editing, and validates reviewer UUID before writing', async () => {
  const notify = vi.spyOn(ExMessage, 'info').mockReturnValue('info')
  writeToken(localStorage, 'admin')
  get.mockImplementation((path: string) => Promise.resolve(path === '/auth/me/review-access' ? { isPlatformAdmin: true, communities: [] } : path === '/communities' ? { items: [{ id: 'rifling-911', displayName: 'Rifling 911', requiresCfx: true, configRevision: 7 }], total: 1, limit: 20, offset: 0 } : { items: [], total: 0, limit: 20, offset: 0 }))
  put.mockResolvedValue({ id: 'rifling-911', displayName: 'Updated', requiresCfx: true, configRevision: 8 })
  render(<MemoryRouter><CommunityAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '管理 Rifling 911' }))
  fireEvent.change(screen.getByLabelText('社区名称'), { target: { value: 'Updated' } })
  fireEvent.click(screen.getByRole('button', { name: '保存社区' }))
  await waitFor(() => expect(notify).toHaveBeenCalledWith('社区配置已保存'))
  expect(put).toHaveBeenCalledWith('/admin/communities/{communityId}', expect.objectContaining({ body: { displayName: 'Updated', requiresCfx: true, expectedRevision: 7 }, headers: { Authorization: 'Bearer admin' } }))
  fireEvent.change(screen.getByLabelText('审核员账号 UUID'), { target: { value: 'email@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: '授予审核权限' }))
  expect(await screen.findByText('请输入有效的账号 UUID')).toBeTruthy()
  expect(put).toHaveBeenCalledTimes(1)
})
