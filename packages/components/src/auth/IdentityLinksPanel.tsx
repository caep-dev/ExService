import { useState, type ReactNode } from 'react'
import { Button } from '@exre/exui'
import styles from './IdentityLinksPanel.module.scss'
export interface IdentityLinkView { externalUserId: string; externalUsername: string; linkedAt: number }
export type IdentityProviderName = 'cfx' | 'google' | 'qq'
export interface IdentityProviderItem {
  provider: IdentityProviderName
  label: string
  available: boolean
  link: IdentityLinkView | null
  busy?: boolean
  impact?: { status: 'pending' | 'error' | 'ready'; communities: string[] }
  authorization?: ReactNode
  onUnlink?: () => Promise<void>
}

/** Presentation only: the Web adapter owns authorization, requests and owner validity. */
export function IdentityLinksPanel({ items }: { items: IdentityProviderItem[] }) {
  const [confirmProvider, setConfirmProvider] = useState<IdentityProviderName | null>(null)
  return <section className={styles.panel} aria-label="关联账户">
    <h2>关联账户</h2>
    {items.map(item => <section key={item.provider} aria-label={`${item.label} 关联`}>
      <h3>{item.label}</h3>
      {item.link ? <>
        <p>{item.link.externalUsername}</p>
        <p>{item.label} ID：{item.link.externalUserId}</p>
        <p>关联时间：{new Date(item.link.linkedAt).toLocaleString()}</p>
        {item.onUnlink && <Button type="button" variant="outline" disabled={item.busy} onClick={() => setConfirmProvider(item.provider)}>解除 {item.label} 关联</Button>}
        {confirmProvider === item.provider && item.onUnlink && <section aria-label="解除关联确认">
          <p>解除后保留本站账号、密码、申请历史及成员资格。</p>
          {item.impact?.status === 'pending' && <p role="status">正在读取社区影响；影响未知。如已加入要求 {item.label} 的社区，解除后须重新关联。</p>}
          {item.impact?.status === 'error' && <p role="status">社区影响未知，请重试读取；解除后可能须重新关联。</p>}
          {item.impact?.status === 'ready' && item.impact.communities.length > 0 && <p>已加入的社区 {item.impact.communities.join('、')} 要求 {item.label}，解除后须重新关联才能满足要求。</p>}
          <Button type="button" disabled={item.busy} onClick={() => void item.onUnlink?.().then(() => setConfirmProvider(null)).catch(() => {})}>确认解除关联</Button>
          <Button type="button" variant="ghost" disabled={item.busy} onClick={() => setConfirmProvider(null)}>取消</Button>
        </section>}
      </> : item.available && item.authorization ? item.authorization : <Button type="button" disabled>{item.label} 暂未开放</Button>}
    </section>)}
  </section>
}
