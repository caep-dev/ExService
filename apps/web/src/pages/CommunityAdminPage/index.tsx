import { useEffect, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button, Card, CardContent, Field, FieldContent, FieldLabel, FieldError, Input, Checkbox, ExMessage } from '@exre/exui'
import type { components } from '@workspace/api-client'
import { api } from '@web/src/api/client'
import { CommunityAuthentication } from '@web/src/join/CommunityAuthentication'
import { currentCommunityToken, useCommunityToken } from '@web/src/join/session'
import styles from './styles.module.scss'

type Community = components['schemas']['Community']
type Reviewer = components['schemas']['CommunityReviewer']
const configSchema = z.object({ id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '使用小写字母、数字和连字符').max(64), displayName: z.string().trim().min(1, '请输入社区名称').max(80, '社区名称最多 80 个字符'), requiresCfx: z.boolean() })
const reviewerSchema = z.object({ userId: z.uuid('请输入有效的账号 UUID') })

export function CommunityAdminPage() {
  const token = useCommunityToken()
  return <main className={styles.page}><h1>社区管理</h1>{token ? <OwnedAdmin key={token} token={token} /> : <CommunityAuthentication onSessionCreated={() => {}} />}</main>
}

function OwnedAdmin({ token }: { token: string }) {
  const [permission, setPermission] = useState<boolean | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [items, setItems] = useState<Community[]>([]), [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [selected, setSelected] = useState<Community | null>(null)
  const headers = { Authorization: `Bearer ${token}` }
  useEffect(() => {
    const abort = new AbortController(); setPermission(null); setItems([]); setSelected(null); setError('')
    void (async () => {
      try {
        const access = await api.GET('/auth/me/review-access', { headers, signal: abort.signal, alert: false })
        if (abort.signal.aborted || currentCommunityToken() !== token) return
        setPermission(access.isPlatformAdmin)
        if (!access.isPlatformAdmin) return
        const page = await api.GET('/communities', { params: { query: { limit: 20, offset } }, headers, signal: abort.signal, alert: false })
        if (!abort.signal.aborted && currentCommunityToken() === token) { setItems(page.items); setTotal(page.total) }
      } catch { if (!abort.signal.aborted && currentCommunityToken() === token) setError('无法读取社区管理权限或列表，请重试。') }
    })()
    return () => abort.abort()
  }, [token, offset, reload])
  return <>
    {error && <p role="alert">{error}</p>}
    {permission === null && !error && <p role="status">正在读取管理权限…</p>}
    {permission === false && <p>当前账号没有平台管理权限。</p>}
    <Button onClick={() => setReload(value => value + 1)}>刷新权限与社区</Button>
    {permission && <>
      <p>平台管理权限用于配置社区和授权审核员；审核申请仍需单独授予社区权限。</p>
      <section aria-label="社区列表">{items.map(item => <Button key={item.id} onClick={() => setSelected(item)}>管理 {item.displayName}</Button>)}
        <p>第 {Math.floor(offset / 20) + 1} 页，共 {total} 个社区</p>
        <Button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页社区</Button>
        <Button disabled={offset + 20 >= total} onClick={() => setOffset(value => value + 20)}>下一页社区</Button>
      </section>
      <Card><CardContent><h2>创建社区</h2><ConfigForm token={token} onSaved={() => setReload(value => value + 1)} /></CardContent></Card>
      {selected && <Card><CardContent><h2>管理 {selected.displayName}</h2><ConfigForm key={`${selected.id}:${selected.configRevision}`} token={token} community={selected} onSaved={value => { setSelected(value); setItems(current => current.map(item => item.id === value.id ? value : item)) }} />
        <Reviewers key={selected.id} token={token} communityId={selected.id} />
      </CardContent></Card>}
    </>}
  </>
}

function ConfigForm({ token, community, onSaved }: { token: string; community?: Community; onSaved: (value: Community) => void }) {
  const form = useForm({ resolver: zodResolver(configSchema), defaultValues: { id: community?.id ?? '', displayName: community?.displayName ?? '', requiresCfx: community?.requiresCfx ?? false } })
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const id = community ? `edit-${community.id}` : 'create-community'
  return <form onSubmit={form.handleSubmit(async values => {
    form.clearErrors('root')
    try {
      const headers = { Authorization: `Bearer ${token}` }
      const result = community ? await api.PUT('/admin/communities/{communityId}', { params: { path: { communityId: community.id } }, body: { displayName: values.displayName, requiresCfx: values.requiresCfx, expectedRevision: community.configRevision }, headers, alert: false }) : await api.POST('/admin/communities', { body: values, headers, alert: false })
      if (live.current && currentCommunityToken() === token) { ExMessage.info('社区配置已保存'); onSaved(result) }
    } catch (issue) {
      if (live.current && currentCommunityToken() === token) form.setError('root', { message: (issue as { status?: number }).status === 409 ? '社区配置已变化或标识已存在，请刷新后重试。' : '社区配置保存失败，请重试。' })
    }
  })} noValidate>
    <Field><FieldContent><FieldLabel htmlFor={`${id}-id`}>社区标识</FieldLabel><Input id={`${id}-id`} readOnly={!!community} {...form.register('id')} aria-invalid={!!form.formState.errors.id} />{form.formState.errors.id && <FieldError>{form.formState.errors.id.message}</FieldError>}</FieldContent></Field>
    <Field><FieldContent><FieldLabel htmlFor={`${id}-name`}>{community ? '社区名称' : '新社区名称'}</FieldLabel><Input id={`${id}-name`} {...form.register('displayName')} aria-invalid={!!form.formState.errors.displayName} />{form.formState.errors.displayName && <FieldError>{form.formState.errors.displayName.message}</FieldError>}</FieldContent></Field>
    <Field><Controller name="requiresCfx" control={form.control} render={({ field }) => <Checkbox id={`${id}-cfx`} checked={field.value} onCheckedChange={value => field.onChange(value === true)} onBlur={field.onBlur} ref={field.ref} />} /><FieldLabel htmlFor={`${id}-cfx`}>要求关联 Cfx</FieldLabel></Field>
    {form.formState.errors.root && <p role="alert">{form.formState.errors.root.message}</p>}
    <Button type="submit" disabled={form.formState.isSubmitting}>{community ? '保存社区' : '创建社区'}</Button>
  </form>
}

function Reviewers({ token, communityId }: { token: string; communityId: string }) {
  const [items, setItems] = useState<Reviewer[]>([]), [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [reload, setReload] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const form = useForm({ resolver: zodResolver(reviewerSchema), defaultValues: { userId: '' } }), live = useRef(true)
  const headers = { Authorization: `Bearer ${token}` }
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const abort = new AbortController(); setItems([]); setError(''); setBusy(true)
    void api.GET('/admin/communities/{communityId}/reviewers', { params: { path: { communityId }, query: { limit: 20, offset } }, headers, signal: abort.signal, alert: false }).then(page => {
      if (!abort.signal.aborted && currentCommunityToken() === token) { setItems(page.items); setTotal(page.total) }
    }).catch(() => { if (!abort.signal.aborted && currentCommunityToken() === token) setError('无法读取审核员列表，请重试。') }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
  }, [token, communityId, offset, reload])
  async function revoke(userId: string) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await api.DELETE('/admin/communities/{communityId}/reviewers/{userId}', { params: { path: { communityId, userId } }, headers, alert: false })
      if (live.current && currentCommunityToken() === token) { ExMessage.info('审核权限已撤销'); setReload(value => value + 1) }
    } catch { if (live.current && currentCommunityToken() === token) setError('撤销审核权限失败，请重试。') }
    finally { if (live.current && currentCommunityToken() === token) setBusy(false) }
  }
  return <section><h3>社区审核员</h3>{error && <p role="alert">{error}</p>}
    <Button onClick={() => setReload(value => value + 1)} disabled={busy}>刷新审核员</Button>
    <ul>{items.map(item => <li key={item.userId}>{item.nickname} · {item.userId}<Button disabled={busy} onClick={() => void revoke(item.userId)}>撤销 {item.nickname}</Button></li>)}</ul>
    <p>第 {Math.floor(offset / 20) + 1} 页，共 {total} 位审核员</p>
    <Button disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页审核员</Button><Button disabled={busy || offset + 20 >= total} onClick={() => setOffset(value => value + 20)}>下一页审核员</Button>
    <form noValidate onSubmit={form.handleSubmit(async ({ userId }) => {
      form.clearErrors('root')
      try {
        await api.PUT('/admin/communities/{communityId}/reviewers/{userId}', { params: { path: { communityId, userId } }, body: {}, headers, alert: false })
        if (live.current && currentCommunityToken() === token) { ExMessage.info('审核权限已授予'); form.reset(); setReload(value => value + 1) }
      } catch { if (live.current && currentCommunityToken() === token) form.setError('root', { message: '授予权限失败，请检查账号是否存在并重试。' }) }
    })}>
      <Field><FieldContent><FieldLabel htmlFor={`reviewer-${communityId}`}>审核员账号 UUID</FieldLabel><Input id={`reviewer-${communityId}`} {...form.register('userId')} aria-invalid={!!form.formState.errors.userId} />{form.formState.errors.userId && <FieldError>{form.formState.errors.userId.message}</FieldError>}</FieldContent></Field>
      {form.formState.errors.root && <p role="alert">{form.formState.errors.root.message}</p>}
      <Button type="submit" disabled={busy || form.formState.isSubmitting}>授予审核权限</Button>
    </form>
  </section>
}
