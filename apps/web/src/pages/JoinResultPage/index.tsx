import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Alert, AlertDescription, Button, Card } from '@exre/exui'
import type { components } from '@workspace/api-client'
import { api } from '@web/src/api/client'
import { ExAxiosError } from '@workspace/sdk/http/browser'
import { CommunityAuthentication } from '@web/src/join/CommunityAuthentication'
import { currentCommunityToken, useCommunityToken } from '@web/src/join/session'
import { IdentityLinksExperience } from '@web/src/settings/IdentityLinksExperience'
import styles from './JoinResultPage.module.scss'

type Status = components['schemas']['MyCommunityStatus']
const statusLabels = { pending: '待审核', approved: '已通过', rejected: '已拒绝' }
export function CommunityStatus({ status }: { status: Status }) {
  return <section aria-live="polite"><h2>{status.communityId}</h2>
    <p>{status.application ? statusLabels[status.application.status] : '尚未申请'}</p>
    {status.application && <p>本账号已使用该社区的一次申请机会，所有审核状态均不能重新申请。</p>}
    <p>{status.membership ? '已取得成员资格' : '尚未取得成员资格'}</p>
    <p>{status.missingProviders.includes('cfx') ? '仍需关联 Cfx' : status.requiredProviders.length ? '当前关联要求已满足' : '当前社区无第三方关联要求'}</p>
    <p>{status.websiteReady ? '网站侧资格与当前要求均已满足' : '网站侧资格或当前要求尚未满足'}</p>
  </section>
}
export function JoinResultPage() {
  const token = useCommunityToken()
  const [legacy, setLegacy] = useState(false)
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('email') || url.searchParams.has('code')) {
      setLegacy(true); url.searchParams.delete('email'); url.searchParams.delete('code')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }, [])
  return <main className={styles.page}><Button asChild variant="link"><Link to="/join/rifling-911">返回加入页</Link></Button>
    <header><h1>我的社区申请</h1><p>查看当前账号在各社区的申请、成员资格与关联要求。</p></header>
    {legacy && <p role="status">结果查询已调整，请登录后查看本人申请；旧邮箱查询参数已清除。</p>}
    {token ? <OwnedResults key={token} token={token} /> : <Card className={styles.card}><p>请登录后查看本人申请。</p><CommunityAuthentication onSessionCreated={() => {}} /></Card>}
  </main>
}
function OwnedResults({ token }: { token: string }) {
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0), [selected, setSelected] = useState('')
  const [page, setPage] = useState<components['schemas']['MyCommunityStatusList'] | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null)
  const [manageLinks, setManageLinks] = useState(false)
  useEffect(() => {
    const abort = new AbortController(); setPage(null); setBusy(true); setError(null); setManageLinks(false)
    void api.GET('/auth/me/communities', { params: { query: { limit: 20, offset } }, headers: { Authorization: `Bearer ${token}` }, signal: abort.signal, alert: false }).then(result => {
      if (abort.signal.aborted || currentCommunityToken() !== token) return
      setPage(result); setSelected(value => result.items.some(item => item.communityId === value) ? value : result.items[0]?.communityId ?? '')
    }).catch(issue => { if (!abort.signal.aborted && currentCommunityToken() === token) setError(issue instanceof ExAxiosError && issue.status === 429 ? '查询过于频繁，请稍后再试' : '无法读取本人社区状态，请重试') })
      .finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
  }, [token, offset, reload])
  const status = page?.items.find(item => item.communityId === selected)
  return <Card className={styles.card} aria-busy={busy}>
    {busy && <p role="status">正在读取本人社区状态</p>}
    {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    <Button variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新本人状态</Button>
    {page && <><label>选择社区<select aria-label="选择社区" value={selected} onChange={event => { setSelected(event.target.value); setManageLinks(false) }}>{page.items.map(item => <option key={item.communityId} value={item.communityId}>{item.communityId}</option>)}</select></label>
      {page.items.length === 0 && <p>暂无社区</p>}
      {status && <><CommunityStatus status={status} /><Button variant="outline" onClick={() => setManageLinks(value => !value)}>管理关联账户</Button></>}
      {manageLinks && <IdentityLinksExperience token={token} />}
      <nav aria-label="本人社区分页"><Button disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</Button><span>第 {Math.floor(offset / 20) + 1} 页，共 {page.total} 个社区</span><Button disabled={busy || offset + 20 >= page.total} onClick={() => setOffset(value => value + 20)}>下一页</Button></nav>
    </>}
  </Card>
}
