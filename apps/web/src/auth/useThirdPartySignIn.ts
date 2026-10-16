import { useEffect, useRef, useState } from 'react'
import type { components } from '@workspace/api-client'
import { api } from '@web/src/api/client'
import { installBrowserSession } from './session-install'
import { readToken, subscribeSessionChanges, type SessionChangeSource } from './storage'

type SignInResult = components['schemas']['CfxSignInResult']
type SignedIn = Extract<SignInResult, { kind: 'signed-in' }>
type Failure = { kind: 'failed'; message: string; retryInstallation: boolean }
type Outcome = SignInResult | Failure
type RunResult = Outcome | { kind: 'stale' }
export interface ThirdPartySignInPresentation {
  onSignedIn: (token: string) => void
  onRegistrationRequired: (grant: Extract<SignInResult, { kind: 'registration-required' }>) => void
  onAccountExists: (email: string) => void
  onFailure: (message: string) => void
}

function present(result: RunResult, presentation: ThirdPartySignInPresentation): void {
  switch (result.kind) {
    case 'signed-in': presentation.onSignedIn(result.token); break
    case 'registration-required': presentation.onRegistrationRequired(result); break
    case 'account-exists': presentation.onAccountExists(result.email); break
    case 'failed': presentation.onFailure(result.message); break
    case 'stale': break
  }
}

/** Owns the Cfx ticket exchange and the complete browser-session settlement. */
export function useThirdPartySignIn(onOwnerChanged?: () => void, isParentInstalling?: (token: string | null, source: SessionChangeSource) => boolean) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const retry = useRef<{ result: SignedIn; owner: string | null } | null>(null)
  const ownerRef = useRef<string | null | undefined>(owner())
  const ownerChangedRef = useRef(onOwnerChanged)
  ownerChangedRef.current = onOwnerChanged
  const parentInstallingRef = useRef(isParentInstalling)
  parentInstallingRef.current = isParentInstalling
  const settling = useRef<{ oldToken: string | null; newToken: string } | null>(null)

  function invalidate() {
    generation.current += 1
    pending.current = false
    retry.current = null
    settling.current = null
    setBusy(false)
    setOutcome(null)
  }

  useEffect(() => {
    const unsubscribe = subscribeSessionChanges((token, source) => {
      if (token === ownerRef.current) return
      const installing = settling.current
      const ownWrite = installing && source === 'write' && token === installing.newToken
      const oldSessionExpired = installing && source === 'http' && token === null && installing.oldToken !== null
      if (ownWrite || oldSessionExpired || parentInstallingRef.current?.(token, source)) { ownerRef.current = token; return }
      ownerRef.current = token
      invalidate()
      ownerChangedRef.current?.()
    })
    return () => {
      unsubscribe()
      generation.current += 1
      pending.current = false
      retry.current = null
      settling.current = null
    }
  }, [])

  function owner(): string | null | undefined {
    try { return readToken(window.localStorage) } catch { return undefined }
  }

  async function settle(result: SignedIn, expectedOwner: string | null, current: () => boolean): Promise<RunResult> {
    if (!current()) return { kind: 'stale' }
    if (owner() !== expectedOwner) {
      const failed: Failure = { kind: 'failed', message: '登录状态已在其他页面更改，请重新授权', retryInstallation: false }
      setOutcome(failed)
      return failed
    }
    const installation = { oldToken: expectedOwner, newToken: result.token }
    settling.current = installation
    let installed: Awaited<ReturnType<typeof installBrowserSession>>
    try { installed = await installBrowserSession(result.token, current) }
    finally { if (settling.current === installation) settling.current = null }
    if (!current() || installed.status === 'stale') return { kind: 'stale' }
    if (installed.status === 'failed') {
      const retryInstallation = owner() === expectedOwner
      retry.current = retryInstallation ? { result, owner: expectedOwner } : null
      const failed: Failure = { kind: 'failed', message: installed.message, retryInstallation }
      setOutcome(failed)
      return failed
    }
    retry.current = null
    setOutcome(result)
    return result
  }

  async function runCfxTicket(ticket: string, signal: AbortSignal, isParentCurrent: () => boolean, presentation: ThirdPartySignInPresentation): Promise<void> {
    if (pending.current || signal.aborted || !isParentCurrent()) return
    const initialOwner = owner()
    if (initialOwner === undefined) {
      const failed: Failure = { kind: 'failed', message: '浏览器无法读取登录信息，请检查存储设置后重试', retryInstallation: false }
      setOutcome(failed)
      present(failed, presentation)
      return
    }
    const version = ++generation.current
    const current = () => version === generation.current && !signal.aborted && isParentCurrent()
    pending.current = true
    retry.current = null
    setOutcome(null)
    setBusy(true)
    try {
      const result = await api.POST('/auth/cfx/sign-in', { body: { identityTicket: ticket }, signal, alert: false })
      if (!current()) return
      if (result.kind === 'signed-in') {
        const installed = await settle(result, initialOwner, current)
        if (current()) present(installed, presentation)
        return
      }
      if (owner() !== initialOwner) return
      setOutcome(result)
      present(result, presentation)
      return
    } catch {
      if (!current()) return
      const failed: Failure = { kind: 'failed', message: 'Cfx 登录未完成，请重新授权', retryInstallation: false }
      setOutcome(failed)
      present(failed, presentation)
      return
    } finally {
      if (version === generation.current) { pending.current = false; setBusy(false) }
    }
  }

  async function retrySessionInstallation(isParentCurrent: () => boolean, presentation: ThirdPartySignInPresentation): Promise<void> {
    const saved = retry.current
    if (!saved || pending.current || !isParentCurrent()) return
    const version = ++generation.current
    const current = () => version === generation.current && isParentCurrent()
    pending.current = true
    setBusy(true)
    try {
      const result = await settle(saved.result, saved.owner, current)
      if (current()) present(result, presentation)
      return
    }
    finally { if (version === generation.current) { pending.current = false; setBusy(false) } }
  }

  return { busy, outcome, runCfxTicket, retrySessionInstallation, invalidate }
}
