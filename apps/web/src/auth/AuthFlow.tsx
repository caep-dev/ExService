import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Alert, AlertDescription, Button } from '@exre/exui'
import {
  AuthForm,
  type AuthFormHandle,
  type AuthFormErrors,
  type LoginDraft,
} from '@workspace/components'
import { api } from '@web/src/api/client'
import { ExAxiosError } from '@workspace/sdk/http/browser'
import { readToken, writeSsoSuccess } from '@web/src/auth/storage'
import type { components } from '@workspace/api-client'
import { installBrowserSession } from './session-install'
import { useThirdPartySignIn, type ThirdPartySignInPresentation } from './useThirdPartySignIn'
import { CfxAuthorization } from '@web/src/registration/CfxAuthorization'
import { PublicRegistrationFlow } from '@web/src/registration/PublicRegistrationFlow'

export interface AuthFlowProps {
  initialMode?: 'login'
  initialEmail?: string
  presentation: 'modal' | 'page'
  ssoRequestId?: string
  onJoin?: () => void
  onFinished?: () => void
  onSessionCreated?: (token: string) => void
  footer?: ReactNode
  description?: ReactNode
}

export function AuthFlow({
  initialEmail = '',
  presentation,
  ssoRequestId,
  onJoin,
  onFinished,
  onSessionCreated,
  footer,
  description,
}: AuthFlowProps) {
  const navigate = useNavigate()
  const [step, setStep] = useState<'credentials' | 'captcha'>('credentials')
  const [flowBusy, setFlowBusy] = useState(ssoRequestId !== undefined)
  const [email, setEmail] = useState(initialEmail)
  const [fatalSsoError, setFatalSsoError] = useState<string | null>(null)
  const [ssoRetryError, setSsoRetryError] = useState<string | null>(null)
  const [cfxBusy,setCfxBusy] = useState(false)
  const [cfxEpoch,setCfxEpoch] = useState(0)
  const [cfxNotice,setCfxNotice] = useState<string|null>(null)
  const [cfxGrant,setCfxGrant] = useState<Extract<components['schemas']['CfxSignInResult'],{kind:'registration-required'}>|null>(null)
  const generation = useRef(0)
  const cfxVersion = useRef(0)
  const authForm = useRef<AuthFormHandle>(null)
  const pendingDraft = useRef<LoginDraft | null>(null)
  const passwordInstalling = useRef<{ oldToken: string | null | undefined; newToken?: string } | null>(null)
  const thirdParty = useThirdPartySignIn(() => {
    generation.current += 1
    pendingDraft.current = null
    setCfxGrant(null)
    setEmail('')
    setStep('credentials')
    setFlowBusy(false)
    setCfxBusy(false)
    setCfxEpoch(value => value + 1)
    setCfxNotice('登录状态已变化，请重新开始')
  }, (token, source) => {
    const installing = passwordInstalling.current
    return !!installing && (
      (source === 'write' && installing.newToken !== undefined && token === installing.newToken)
      || (source === 'http' && token === null && installing.oldToken !== null && installing.oldToken !== undefined)
    )
  })
  const cfxPresentation: ThirdPartySignInPresentation = {
    onSignedIn: finishInstalledSession,
    onRegistrationRequired: grant => { pendingDraft.current = null; setCfxGrant(grant) },
    onAccountExists: targetEmail => { setEmail(targetEmail); setCfxNotice('该邮箱已有账号，请登录后在设置中主动关联 Cfx。') },
    onFailure: setCfxNotice,
  }

  useEffect(() => () => {
    generation.current += 1
    pendingDraft.current = null
  }, [])

  function continueLogin(draft: LoginDraft) {
    thirdParty.invalidate()
    generation.current += 1
    pendingDraft.current = draft
    setEmail(draft.email)
    setStep('captcha')
  }

  async function submitCaptcha(_answer: string) {
    const draft = pendingDraft.current
    if (draft === null) return
    await submitLogin(draft)
  }

  useEffect(() => {
    if (ssoRequestId === undefined) {
      setFlowBusy(false)
      return
    }
    const current = ++generation.current
    void prepareSso(ssoRequestId, current)
  }, [ssoRequestId])

  async function prepareSso(requestId: string, current: number) {
    thirdParty.invalidate()
    setFatalSsoError(null)
    setSsoRetryError(null)
    setFlowBusy(true)
    try {
      await api.POST('/auth/sso/inspect', { body: { ssoRequestId: requestId }, alert: false })
      if (current !== generation.current) return
      let token: string | null
      try {
        token = readToken(window.localStorage)
      } catch {
        authForm.current?.setServerErrors({ form: '浏览器无法读取登录信息，请使用邮箱和密码继续' })
        setFlowBusy(false)
        return
      }
      if (token === null) {
        setFlowBusy(false)
        return
      }
      await api.POST('/auth/sso/confirm', { body: { ssoRequestId: requestId }, alert: false })
      if (current !== generation.current) return
      finishSso(requestId)
    } catch (error) {
      if (current === generation.current) {
        if (error instanceof ExAxiosError && error.code === 'SESSION_INVALID') {
          setFlowBusy(false)
          return
        }
        if (error instanceof ExAxiosError && isFatalSsoCode(error.code)) setFatalSsoError(error.message)
        else setSsoRetryError('暂时无法连接认证服务，请重试')
        setFlowBusy(false)
      }
    }
  }

  async function submitLogin(draft: LoginDraft) {
    const current = ++generation.current
    thirdParty.invalidate()
    let oldToken: string | null | undefined
    try { oldToken = readToken(window.localStorage) } catch { oldToken = undefined }
    const passwordAttempt = { oldToken }
    passwordInstalling.current = passwordAttempt
    authForm.current?.clearServerErrors()
    try {
      if (ssoRequestId !== undefined) {
        await api.POST('/auth/sso/login', {
          body: { ssoRequestId, email: draft.email, password: draft.password }, alert: false,
        })
        if (current !== generation.current) return
        finishSso(ssoRequestId)
        return
      }

      const result = await api.POST('/auth/login', {
        body: { email: draft.email, password: draft.password }, alert: false,
      })
      if (current !== generation.current) return
      await acceptSession(result.token,current)
    } catch (error) {
      if (current !== generation.current) return
      if (error instanceof ExAxiosError) {
        if (isFatalSsoCode(error.code)) setFatalSsoError(error.message)
        else authForm.current?.setServerErrors(mapError(error.code, error.message))
      } else authForm.current?.setServerErrors({ form: '暂时无法连接认证服务，请重试' })
    } finally {
      if (passwordInstalling.current === passwordAttempt) passwordInstalling.current = null
    }
  }

  async function acceptSession(token:string,current:number,signal?:AbortSignal) {
    let oldToken:string|null|undefined
    try { oldToken=readToken(window.localStorage) } catch { oldToken=undefined }
    const installing={oldToken,newToken:token}
    passwordInstalling.current=installing
    let installed:Awaited<ReturnType<typeof installBrowserSession>>
    try { installed=await installBrowserSession(token,()=>current===generation.current&&!signal?.aborted) }
    finally { if(passwordInstalling.current===installing)passwordInstalling.current=null }
    if(installed.status==='failed'){authForm.current?.setServerErrors({form:installed.message});return}
    if(installed.status!=='installed')return
    if(onSessionCreated){onSessionCreated(token);return}
    onFinished?.()
    if(presentation==='modal')window.location.reload()
    else window.location.replace('/')
  }
  async function cfx(ticket:string,_attemptId:string,signal:AbortSignal) {
    const current=++generation.current
    cfxVersion.current=current
    setCfxNotice(null)
    await thirdParty.runCfxTicket(ticket,signal,()=>current===generation.current,cfxPresentation)
  }

  function finishInstalledSession(token:string) {
    if(onSessionCreated){onSessionCreated(token);return}
    onFinished?.()
    if(presentation==='modal')window.location.reload()
    else window.location.replace('/')
  }

  async function retryCfxInstallation() {
    const current=cfxVersion.current
    await thirdParty.retrySessionInstallation(()=>current===generation.current,cfxPresentation)
  }

  function join() {
    generation.current += 1
    thirdParty.invalidate()
    pendingDraft.current = null
    if (onJoin) onJoin()
    else navigate('/register')
  }

  function finishSso(requestId: string) {
    try {
      writeSsoSuccess(window.sessionStorage, { ssoRequestId: requestId, confirmedAt: Date.now() })
    } catch {
      authForm.current?.setServerErrors({ form: '浏览器无法保存本次确认结果，请重试' })
      setFlowBusy(false)
      return
    }
    onFinished?.()
    window.location.replace('/sso/success')
  }

  const visibleFooter = step === 'captcha' ? null : footer

  if(cfxGrant!==null&&ssoRequestId===undefined)return <PublicRegistrationFlow presentation={presentation} initialGrant={cfxGrant} onSessionCreated={onSessionCreated}
    onLogin={targetEmail=>{thirdParty.invalidate();generation.current+=1;setCfxGrant(null);setEmail(targetEmail);setStep('credentials')}}/>

  if (fatalSsoError !== null) {
    return <><Alert variant="destructive" role="alert"><AlertDescription>{fatalSsoError}</AlertDescription></Alert>{visibleFooter}</>
  }

  if (ssoRetryError !== null && ssoRequestId !== undefined) {
    return (
      <>
        <Alert variant="destructive" role="alert">
          <AlertDescription>{ssoRetryError}</AlertDescription>
          <Button type="button" variant="outline" onClick={() => void prepareSso(ssoRequestId, ++generation.current)}>
            重试
          </Button>
        </Alert>
        {visibleFooter}
      </>
    )
  }

  return (
    <>
      <AuthForm
      key={email}
      ref={authForm}
      step={step}
      busy={flowBusy||cfxBusy||thirdParty.busy}
      initialEmail={email}
      description={description}
      onContinueLogin={continueLogin}
      onCaptchaSubmit={submitCaptcha}
      onJoin={join}
      />
      {cfxNotice&&<p role="status">{cfxNotice}</p>}
      {thirdParty.outcome?.kind==='failed'&&thirdParty.outcome.retryInstallation&&<Button type="button" disabled={thirdParty.busy} onClick={()=>void retryCfxInstallation()}>重试完成登录</Button>}
      {ssoRequestId===undefined&&step==='credentials'&&<CfxAuthorization key={cfxEpoch} disabled={flowBusy||thirdParty.busy} onActiveChange={setCfxBusy} onTicket={cfx}/>}
      {visibleFooter}
    </>
  )
}

function mapError(code: string, message: string): AuthFormErrors {
  if (code === 'EMAIL_IN_USE') return { email: message }
  if (code === 'INVALID_CREDENTIALS') return { form: '邮箱或密码错误' }
  if (code.startsWith('CODE_')) return { code: message }
  return { form: message || '请求失败，请稍后重试' }
}

function isFatalSsoCode(code: string): boolean {
  return code === 'SSO_REQUEST_NOT_FOUND' || code === 'SSO_REQUEST_EXPIRED' || code === 'SSO_ACCOUNT_CONFLICT'
}
