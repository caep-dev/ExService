import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { AuthModal, SiteHeader } from '@workspace/components'
import type { SettingsCategory } from '@workspace/components'
import { AuthFlow } from '@web/src/auth/AuthFlow'
import { useAuth } from '@web/src/auth/AuthContext'
import {
  NotificationBellSlot, NotificationHistoryModalSlot, NotificationsProvider,
} from '@web/src/notifications/NotificationsExperience'
import { SettingsModal } from '@web/src/settings/SettingsExperience'
import { PublicRegistrationFlow } from '@web/src/registration/PublicRegistrationFlow'

export interface SiteOutletContext { requestLogin(trigger: HTMLElement): void }

/**
 * 站点布局层：提供站点顶栏与嵌套路由的挂载点。
 *
 * 登录与注册独立页不经过此布局；其余页面（含 `*`）共用导航。
 */
export function RootLayout({ glassAtTop = false }: { glassAtTop?: boolean }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const [loginEmail, setLoginEmail] = useState('')
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null)
  const menuButton = useRef<HTMLSpanElement>(null)
  const mobileMenuButton = useRef<HTMLSpanElement>(null)
  const registerButton = useRef<HTMLButtonElement>(null)
  const loginButton = useRef<HTMLButtonElement>(null)
  const authTrigger = useRef<'login' | 'register'>('login')
  const pageAuthTrigger = useRef<HTMLElement | null>(null)
  const requestLogin: SiteOutletContext['requestLogin'] = trigger => {
    pageAuthTrigger.current = trigger
    authTrigger.current = 'login'
    setLoginEmail('')
    auth.openModal('login')
  }
  const join = () => { auth.closeModal(); navigate('/join/rifling-911') }
  useEffect(() => {
    if (auth.state.status === 'anonymous') setSettingsCategory(null)
  }, [auth.state.status])
  const closeSettings = () => {
    setSettingsCategory(null)
    requestAnimationFrame(() => {
      const isMobile = window.matchMedia('(max-width: 52rem)').matches
      const target = isMobile ? mobileMenuButton.current : menuButton.current
      target?.querySelector('button')?.focus()
    })
  }

  return (
    // 通知状态与 API 归 `apps/web`；铃铛只是顶栏的一个槽位，Modal 由门户挂载。
    <NotificationsProvider>
      <SiteHeader glassAtTop={glassAtTop} mobileMenuButtonRef={mobileMenuButton}
        notifications={<NotificationBellSlot />} auth={{
          state: auth.state,
          onLogin: () => { pageAuthTrigger.current = null; authTrigger.current = 'login'; setLoginEmail(''); auth.openModal('login') },
          onRegister: () => { pageAuthTrigger.current = null; authTrigger.current = 'register'; setLoginEmail(''); auth.openModal('register') },
          onRetry: auth.retrySession,
          onLogout: auth.logout,
          onProfile: () => setSettingsCategory('profile'),
          onSettings: () => setSettingsCategory('general'),
          menuButtonRef: menuButton,
          registerButtonRef: registerButton,
          loginButtonRef: loginButton,
        }} />
      <Outlet context={{ requestLogin } satisfies SiteOutletContext} />
      {settingsCategory !== null && auth.state.status !== 'anonymous' &&
        <SettingsModal key={settingsCategory} initialCategory={settingsCategory}
          onClose={closeSettings} />}
      {auth.modalMode !== null && (
        <AuthModal
          open
          mode={auth.modalMode}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const pageTrigger = pageAuthTrigger.current
            pageAuthTrigger.current = null
            if (pageTrigger?.isConnected && !pageTrigger.matches(':disabled, [hidden], [inert], [inert] *')) {
              pageTrigger.focus()
              if (document.activeElement === pageTrigger) return
            }
            if (window.matchMedia('(max-width: 52rem)').matches) mobileMenuButton.current?.querySelector('button')?.focus()
            else (authTrigger.current === 'register' ? registerButton.current : loginButton.current)?.focus()
          }}
          onOpenChange={(open) => {
            if (!open) auth.closeModal()
          }}
        >
          {auth.modalMode === 'register' ? <PublicRegistrationFlow presentation="modal"
            onJoin={join} onLogin={email => { setLoginEmail(email); auth.openModal('login') }} /> : <AuthFlow
            initialMode="login"
            initialEmail={loginEmail}
            presentation="modal"
            onJoin={() => auth.openModal('register')}
            onFinished={auth.closeModal}
          />}
        </AuthModal>
      )}
      <NotificationHistoryModalSlot />
    </NotificationsProvider>
  )
}
