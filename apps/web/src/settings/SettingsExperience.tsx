import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@exre/exui'
import { SettingsPanel, type SettingsCategory } from '@workspace/components'
import { useAuth } from '@web/src/auth/AuthContext'
import { readToken, subscribeSessionChanges } from '@web/src/auth/storage'
import { useNotificationPreferencesController } from '@web/src/notifications/useNotificationPreferencesController'
import { useSettingsController } from '@web/src/settings/useSettingsController'
import styles from '@web/src/settings/SettingsExperience.module.scss'
import {IdentityLinksExperience} from './IdentityLinksExperience'

type SettingsSource = 'profile' | 'notifications'

/**
 * 设置分区。
 *
 * 两个数据来源（资料 / 通知偏好）各自独立：进入哪个来源才读哪个来源，
 * 失败与重试都只指向自己所在的分区，双向失败不互相阻塞，主题照常可用。
 *
 * 原来的两处资料加载 effect（「已有快照或错误就刷新」与「non-general idle 就读取」）
 * 在这里被合并成一处**按分类显式触发**的读取，并且两处都收窄了：
 * 通知分区不再因为资料已就绪或资料失败而被触发，资料也不再因为切到通知而被触发。
 */
export function SettingsExperience({ initialCategory }: { initialCategory: SettingsCategory }) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory)
  const settings = useSettingsController()
  // 分类投影：与 SettingsPanel 的可见性 prop 同源，但只作 module 的发送前资格判断。
  const preferences = useNotificationPreferencesController({ active: category === 'notifications' })
  const auth = useAuth()

  // 会话代次：换号后重新读取一次服务器已保存值，不沿用上一个账号的「已读过」记号。
  const [sessionToken, setSessionToken] = useState<string | null>(() => currentToken())
  const entered = useRef(new Set<string>())

  useEffect(() => subscribeSessionChanges(() => setSessionToken(currentToken())), [])

  // StrictMode 清理会使控制层的在途读取失效；重新挂载时必须允许再次读取。
  useEffect(() => () => { entered.current.clear() }, [])

  useEffect(() => {
    if (auth.state.status !== 'authenticated') return
    const source: SettingsSource | null =
      category === 'profile' || category === 'account' ? 'profile'
        : category === 'notifications' ? 'notifications' : null
    // 初始为 general 时不由设置层触发任何读取。
    if (source === null) return
    const key = `${sessionToken ?? 'anonymous'}:${source}`
    if (entered.current.has(key)) return
    entered.current.add(key)
    if (source === 'profile') void settings.load()
    else void preferences.load()
  }, [category, auth.state.status, sessionToken, settings.load, preferences.load])

  const profile = settings.snapshot.profile.snapshot
  const authUnavailableWithoutProfile = auth.state.status === 'unavailable' && !profile
  return <SettingsPanel category={category} onCategoryChange={setCategory}
    theme={settings.snapshot.general.theme} onThemeChange={settings.setTheme}
    profile={profile ? {
      email: profile.email, nickname: profile.nickname, qq: profile.qq ?? null,
      fivemId: profile.fivemId ?? null, avatarUrl: profile.avatarUrl ?? null,
    } : null}
    profileStatus={authUnavailableWithoutProfile ? 'error' : settings.snapshot.profile.status}
    profileError={authUnavailableWithoutProfile ? settings.authMessage ?? '登录状态不可用' : settings.snapshot.profile.error}
    onRetry={authUnavailableWithoutProfile ? settings.retryAuth : () => void settings.load()}
    notifications={preferences.slice}
    identityLinks={category==='identity-links'?<IdentityLinksExperience key={sessionToken} token={sessionToken}/>:null}
    onSave={settings.save} onUpload={settings.upload}
    onRemoveAvatar={settings.removeAvatar} onLogout={settings.logout}
    logoutPending={settings.logoutPending} actionPending={settings.actionPending}
    authMessage={settings.authMessage} onRetryAuth={settings.retryAuth} />
}

export function SettingsModal({ initialCategory, onClose }: {
  initialCategory: SettingsCategory; onClose: () => void
}) {
  const auth = useAuth()
  useEffect(() => { if (auth.state.status === 'anonymous') onClose() }, [auth.state.status, onClose])
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className={styles.modal}>
      <DialogTitle className={styles.visuallyHidden}>设置</DialogTitle>
      <SettingsExperience initialCategory={initialCategory} />
    </DialogContent>
  </Dialog>
}

function currentToken(): string | null {
  try { return readToken(window.localStorage) }
  catch { return null }
}
