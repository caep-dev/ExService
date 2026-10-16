import { useState } from 'react'
import { AuthFlow } from '@web/src/auth/AuthFlow'
import { PublicRegistrationFlow } from '@web/src/registration/PublicRegistrationFlow'

/** Join-origin auth keeps the caller mounted and never navigates or submits a draft. */
export function CommunityAuthentication({ onSessionCreated }: { onSessionCreated: (token: string) => void }) {
  const [register, setRegister] = useState(false), [email, setEmail] = useState('')
  return register ? <PublicRegistrationFlow presentation="modal" onSessionCreated={onSessionCreated} onLogin={value => { setEmail(value); setRegister(false) }} />
    : <AuthFlow presentation="modal" initialEmail={email} onSessionCreated={onSessionCreated} onJoin={() => setRegister(true)} description="登录后继续当前社区申请，已填写的资料会保留。" />
}
