// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { AUTH_TOKEN_KEY, syncSessionToken } from './storage'
import { ExAxiosError } from '@workspace/sdk/http/browser'

const post = vi.hoisted(() => vi.fn())
vi.mock('@web/src/api/client', () => ({ api: { POST: post }, revokePreviousSessionForReplacement: (token: string) => post('/auth/logout', { headers: { Authorization: `Bearer ${token}` }, alert: false }) }))

import { useThirdPartySignIn } from './useThirdPartySignIn'

const passivePresentation = { onSignedIn: () => {}, onRegistrationRequired: () => {}, onAccountExists: () => {}, onFailure: () => {} }

afterEach(() => { cleanup(); post.mockReset(); window.localStorage.clear() })

it.each([
  { response: { kind: 'signed-in', token: 'new-token', expiresAt: 123 }, callback: 'onSignedIn', value: 'new-token' },
  { response: { kind: 'registration-required', registrationToken: 'grant', email: 'new@example.com', suggestedNickname: 'Member', expiresAt: 123 }, callback: 'onRegistrationRequired', value: 'grant' },
  { response: { kind: 'account-exists', email: 'existing@example.com', nextAction: 'login_then_link' }, callback: 'onAccountExists', value: 'existing@example.com' },
] as const)('dispatches $response.kind through one presentation interface', async ({ response, callback, value }) => {
  post.mockResolvedValue(response)
  const presentation = { onSignedIn: vi.fn(), onRegistrationRequired: vi.fn(), onAccountExists: vi.fn(), onFailure: vi.fn() }
  const { result } = renderHook(() => useThirdPartySignIn())
  await act(async () => { await result.current.runCfxTicket('ticket', new AbortController().signal, () => true, presentation) })
  expect(presentation[callback]).toHaveBeenCalledOnce()
  if (callback === 'onRegistrationRequired') expect(presentation.onRegistrationRequired.mock.calls[0]?.[0].registrationToken).toBe(value)
  else expect(presentation[callback]).toHaveBeenCalledWith(value)
  expect(Object.values(presentation).reduce((total, handler) => total + handler.mock.calls.length, 0)).toBe(1)
})

it.each([
  { kind: 'registration-required', registrationToken: 'grant', email: 'new@example.com', suggestedNickname: 'Member', expiresAt: 123 },
  { kind: 'account-exists', email: 'existing@example.com', nextAction: 'login_then_link' },
] as const)('keeps the current $kind outcome without installing a session', async response => {
  post.mockResolvedValue(response)
  const { result } = renderHook(() => useThirdPartySignIn())
  await act(async () => { await result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  expect(result.current.outcome).toMatchObject(response)
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
})

it('holds the login lock until old-session revocation settles', async () => {
  window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
  let release!: () => void
  post.mockImplementation((path: string) => path === '/auth/cfx/sign-in'
    ? Promise.resolve({ kind: 'signed-in', token: 'new-token', expiresAt: 123 })
    : new Promise<void>(resolve => { release = resolve }))
  const { result } = renderHook(() => useThirdPartySignIn())
  let run!: Promise<unknown>
  act(() => { run = result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  await waitFor(() => expect(result.current.busy).toBe(true))
  await waitFor(() => expect(release).toBeDefined())
  await result.current.runCfxTicket('duplicate', new AbortController().signal, () => true, passivePresentation)
  expect(post.mock.calls.filter(([path]) => path === '/auth/cfx/sign-in')).toHaveLength(1)
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('old-token')
  await act(async () => { release(); await run })
  expect(result.current.outcome).toMatchObject({ kind: 'signed-in', token: 'new-token' })
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
})

it('does not install a late result after invalidation or browser-owner change', async () => {
  let finish!: (value: unknown) => void
  post.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = renderHook(() => useThirdPartySignIn())
  let run!: Promise<unknown>
  act(() => { run = result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  act(() => result.current.invalidate())
  await act(async () => { finish({ kind: 'signed-in', token: 'late-token' }); await run })
  expect(result.current.outcome).toBeNull()
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()

  act(() => { run = result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  window.localStorage.setItem(AUTH_TOKEN_KEY, 'other-tab-token')
  await act(async () => { finish({ kind: 'signed-in', token: 'late-token' }); await run })
  expect(result.current.outcome).toMatchObject({ kind: 'failed' })
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('other-tab-token')
})

it('retries only the session installation after old-session revocation fails', async () => {
  window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
  let logoutAttempts = 0
  post.mockImplementation((path: string) => path === '/auth/cfx/sign-in'
    ? Promise.resolve({ kind: 'signed-in', token: 'new-token', expiresAt: 123 })
    : ++logoutAttempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ status: 'ok' }))
  const { result } = renderHook(() => useThirdPartySignIn())
  await act(async () => { await result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  expect(result.current.outcome).toMatchObject({ kind: 'failed', retryInstallation: true })
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('old-token')
  await act(async () => { await result.current.retrySessionInstallation(() => true, passivePresentation) })
  expect(result.current.outcome).toMatchObject({ kind: 'signed-in', token: 'new-token' })
  expect(post.mock.calls.filter(([path]) => path === '/auth/cfx/sign-in')).toHaveLength(1)
})

it('discards a late ticket and a pending session install when cancelled', async () => {
  let finish!: (value: unknown) => void
  post.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = renderHook(() => useThirdPartySignIn())
  const abort = new AbortController()
  let run!: Promise<unknown>
  act(() => { run = result.current.runCfxTicket('ticket', abort.signal, () => true, passivePresentation) })
  abort.abort()
  await act(async () => { finish({ kind: 'signed-in', token: 'late-token' }); await run })
  expect(result.current.outcome).toBeNull()

  window.localStorage.setItem(AUTH_TOKEN_KEY, 'old-token')
  post.mockImplementation((path: string) => path === '/auth/cfx/sign-in'
    ? Promise.resolve({ kind: 'signed-in', token: 'late-token', expiresAt: 123 })
    : new Promise(resolve => { finish = resolve }))
  act(() => { run = result.current.runCfxTicket('ticket', new AbortController().signal, () => true, passivePresentation) })
  await waitFor(() => expect(post.mock.calls.some(([path]) => path === '/auth/logout')).toBe(true))
  act(() => result.current.invalidate())
  await act(async () => { finish({ status: 'ok' }); await run })
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
  expect(result.current.outcome).toBeNull()
})

it('drops a pending ticket response after an external owner change', async () => {
  let finish!: (value: unknown) => void
  post.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const changed = vi.fn()
  const presentation = { onSignedIn: vi.fn(), onRegistrationRequired: vi.fn(), onAccountExists: vi.fn(), onFailure: vi.fn() }
  const { result } = renderHook(() => useThirdPartySignIn(changed))
  let run!: Promise<void>
  act(() => { run = result.current.runCfxTicket('ticket', new AbortController().signal, () => true, presentation) })
  act(() => { window.localStorage.setItem(AUTH_TOKEN_KEY, 'other-owner'); syncSessionToken('storage') })
  await act(async () => { finish({ kind: 'registration-required', registrationToken: 'old-grant', email: 'old@example.com', suggestedNickname: null, expiresAt: 123 }); await run })
  expect(changed).toHaveBeenCalledOnce()
  expect(result.current.outcome).toBeNull()
  expect(Object.values(presentation).every(handler => handler.mock.calls.length === 0)).toBe(true)
})

it('keeps its own session installation current, including old-session expiry cleanup', async () => {
  window.localStorage.setItem(AUTH_TOKEN_KEY, 'expired-token')
  post.mockImplementation((path: string) => {
    if (path === '/auth/cfx/sign-in') return Promise.resolve({ kind: 'signed-in', token: 'new-token', expiresAt: 123 })
    window.localStorage.removeItem(AUTH_TOKEN_KEY)
    syncSessionToken('http')
    return Promise.reject(new ExAxiosError('http', 'SESSION_INVALID', 'Expired', { status: 401 }))
  })
  const changed = vi.fn()
  const presentation = { onSignedIn: vi.fn(), onRegistrationRequired: vi.fn(), onAccountExists: vi.fn(), onFailure: vi.fn() }
  const { result } = renderHook(() => useThirdPartySignIn(changed))
  await act(async () => { await result.current.runCfxTicket('ticket', new AbortController().signal, () => true, presentation) })
  expect(changed).not.toHaveBeenCalled()
  expect(presentation.onSignedIn).toHaveBeenCalledExactlyOnceWith('new-token')
  expect(result.current.outcome).toMatchObject({ kind: 'signed-in' })
  expect(window.localStorage.getItem(AUTH_TOKEN_KEY)).toBe('new-token')
})
