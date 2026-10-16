// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IdentityLinksPanel } from './IdentityLinksPanel'

afterEach(cleanup)

it('renders shuffled providers by identity and keeps an unavailable linked provider removable', async () => {
  const user = userEvent.setup()
  const onUnlink = vi.fn().mockResolvedValue(undefined)
  render(<IdentityLinksPanel items={[
    { provider: 'qq', label: 'QQ', available: false, link: null },
    { provider: 'cfx', label: 'Cfx', available: false, link: { externalUserId: '123', externalUsername: 'Member', linkedAt: 1_800_000_000_000 }, onUnlink, impact: { status: 'error', communities: [] } },
    { provider: 'google', label: 'Google', available: false, link: null },
  ]} />)
  expect(screen.getByText('Cfx ID：123')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Google 暂未开放' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '解除 Cfx 关联' }))
  expect(screen.getByText(/社区影响未知/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '确认解除关联' }))
  expect(onUnlink).toHaveBeenCalledOnce()
})
