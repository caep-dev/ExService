import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Button, ExMessage } from '@exre/exui'
import { IdentityLinksPanel } from '@workspace/components'
import type { components } from '@workspace/api-client'
import { api } from '@web/src/api/client'
import { CfxAuthorization } from '@web/src/registration/CfxAuthorization'

type Links = components['schemas']['IdentityLinksResponse']
type Provider = Links['providers'][number]['provider']
type Impact = { status: 'pending' | 'error' | 'ready'; communities: string[] }
type PanelItem = ComponentProps<typeof IdentityLinksPanel>['items'][number]
const providers: readonly Provider[] = ['cfx', 'google', 'qq']
const labels: Record<Provider, string> = { cfx: 'Cfx', google: 'Google', qq: 'QQ' }
const pendingImpact = (): Record<Provider, Impact> => ({
  cfx: { status: 'pending', communities: [] },
  google: { status: 'pending', communities: [] },
  qq: { status: 'pending', communities: [] },
})

export function IdentityLinksExperience({ token }: { token: string | null }) {
  return <OwnedIdentityLinks key={token ?? 'anonymous'} token={token} />
}

function OwnedIdentityLinks({ token }: { token: string | null }) {
  const [links, setLinks] = useState<Links | null>(null)
  const [impact, setImpact] = useState<Record<Provider, Impact>>(pendingImpact)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Provider | null>(null)
  const [unconfirmed, setUnconfirmed] = useState<Provider | null>(null)
  const [reload, setReload] = useState(0)
  const owner = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const writing = useRef<Set<Provider>>(new Set())
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const current = (version: number) => version === owner.current && !controller.current?.signal.aborted

  useEffect(() => {
    const version = ++owner.current
    const abort = new AbortController()
    controller.current = abort
    writing.current.clear()
    setLinks(null)
    setImpact(pendingImpact())
    setError(null)
    setBusy(null)
    if (token) {
      void (async () => {
        try {
          const result = await api.GET('/auth/me/identity-links', { headers, signal: abort.signal, alert: false })
          if (current(version)) { setLinks(result); setUnconfirmed(null) }
        } catch { if (current(version)) setError('无法读取关联账户，请重试') }
      })()
      void (async () => {
        try {
          const communities: Record<Provider, string[]> = { cfx: [], google: [], qq: [] }
          let offset = 0
          while (!abort.signal.aborted) {
            const page = await api.GET('/auth/me/communities', { params: { query: { limit: 50, offset } }, headers, signal: abort.signal, alert: false })
            for (const item of page.items) {
              if (!item.membership) continue
              for (const provider of providers) {
                if (item.requiredProviders.some(required => (required as string) === provider)) communities[provider].push(item.communityId)
              }
            }
            offset += page.items.length
            if (offset >= page.total || page.items.length === 0) break
          }
          if (current(version)) setImpact({
            cfx: { status: 'ready', communities: communities.cfx },
            google: { status: 'ready', communities: communities.google },
            qq: { status: 'ready', communities: communities.qq },
          })
        } catch {
          if (current(version)) setImpact({
            cfx: { status: 'error', communities: [] },
            google: { status: 'error', communities: [] },
            qq: { status: 'error', communities: [] },
          })
        }
      })()
    }
    return () => { owner.current++; abort.abort(); writing.current.clear() }
  }, [token, reload])

  async function reconcile(version: number): Promise<Links | null> {
    try {
      const result = await api.GET('/auth/me/identity-links', { headers, signal: controller.current?.signal, alert: false })
      if (!current(version)) return null
      setLinks(result)
      setUnconfirmed(null)
      return result
    } catch {
      if (current(version)) { setUnconfirmed('cfx'); setError('关联结果暂时无法确认，请重新读取关联账户') }
      return null
    }
  }

  async function writeCfx(action: 'link' | 'unlink', ticket?: string, attemptId?: string, signal?: AbortSignal): Promise<void> {
    if (!token || writing.current.has('cfx') || unconfirmed === 'cfx') return
    if (action === 'link' && (!ticket || !attemptId || !signal)) return
    const version = owner.current
    writing.current.add('cfx')
    setBusy('cfx')
    setError(null)
    let issue: unknown
    try {
      if (action === 'link') {
        await api.POST('/auth/me/identity-links/cfx', { body: { identityTicket: ticket!, attemptId: attemptId! }, headers, signal, alert: false })
      } else await api.DELETE('/auth/me/identity-links/cfx', { headers, signal: controller.current?.signal, alert: false })
    } catch (error) { issue = error }
    try {
      if (!current(version)) return
      // A lost response can follow a committed write. Always ask the current owner.
      const confirmed = await reconcile(version)
      if (!current(version)) return
      if (!confirmed) throw issue ?? new Error('identity link readback failed')
      const linked = (confirmed.providers.find(item => item.provider === 'cfx')?.link ?? null) !== null
      if ((action === 'link') === linked) {
        ExMessage.info(action === 'link' ? '已关联 Cfx' : '已解除 Cfx 关联')
        return
      }
      setError(action === 'link' ? '关联未完成，请重新授权' : '解除关联未完成，请重试')
      throw issue ?? new Error('identity link write not confirmed')
    } finally {
      if (current(version)) { writing.current.delete('cfx'); setBusy(null) }
    }
  }

  if (!token) return <p>登录后可以管理关联账户。</p>
  if (!links) return <section>{error ? <><p role="alert">{error}</p><Button onClick={() => setReload(value => value + 1)}>重试关联账户</Button></> : <p role="status">正在读取关联账户…</p>}</section>
  const byProvider = new Map(links.providers.map(item => [item.provider, item]))
  if (providers.some(provider => !byProvider.has(provider))) return <section><p role="alert">关联账户资料不完整，请重试</p><Button onClick={() => setReload(value => value + 1)}>重试关联账户</Button></section>
  const items: PanelItem[] = providers.map(provider => {
    const entry = byProvider.get(provider)!
    return {
      provider, label: labels[provider], available: entry.available, link: entry.link,
      busy: busy === provider || unconfirmed === provider, impact: impact[provider],
      ...(provider === 'cfx' ? {
        onUnlink: () => writeCfx('unlink'),
        authorization: <CfxAuthorization token={token} disabled={busy === provider || unconfirmed === provider} onTicket={(ticket, attemptId, signal) => writeCfx('link', ticket, attemptId, signal)} />,
      } : {}),
    }
  })
  return <>
    <IdentityLinksPanel key={token} items={items} />
    {impact.cfx.status === 'pending' && <p role="status">社区影响查询中；影响未知，解除后可能须重新关联。</p>}
    {impact.cfx.status === 'error' && <><p role="status">暂时无法读取社区影响；影响未知，解除后可能须重新关联。</p><Button onClick={() => setReload(value => value + 1)}>重试社区影响</Button></>}
    {error && <><p role="alert">{error}</p><Button onClick={() => setReload(value => value + 1)}>重新读取关联账户</Button></>}
  </>
}
