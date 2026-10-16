// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { JoinResultPage } from '@web/src/pages/JoinResultPage'
import { writeToken, clearBrowserSession } from '@web/src/auth/storage'
const get = vi.hoisted(() => vi.fn())
vi.mock('@web/src/api/client', () => ({ api: { GET: get } }))
afterEach(() => { cleanup(); clearBrowserSession(); get.mockReset() })
it('reads only the signed-in account community status and removes it immediately on logout', async () => {
  writeToken(localStorage, 'owner-token')
  get.mockResolvedValue({ items: [{ communityId: 'rifling-911', application: { id: 'a', status: 'approved', createdAt: 1, reviewedAt: 2 }, membership: { applicationId: 'a', joinedAt: 2 }, requiredProviders: ['cfx'], missingProviders: ['cfx'], requirementsMet: false, websiteReady: false }], total: 1, limit: 20, offset: 0 })
  render(<MemoryRouter><JoinResultPage /></MemoryRouter>)
  expect(await screen.findByText('已取得成员资格')).toBeTruthy()
  expect(screen.getByText('仍需关联 Cfx')).toBeTruthy()
  expect(get).toHaveBeenCalledWith('/auth/me/communities', expect.objectContaining({ headers: { Authorization: 'Bearer owner-token' } }))
  act(() => clearBrowserSession())
  expect(screen.queryByText('已取得成员资格')).toBeNull()
  expect(screen.queryByLabelText('申请邮箱')).toBeNull()
})
