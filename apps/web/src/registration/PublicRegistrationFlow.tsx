import {useEffect,useRef,useState} from 'react'
import {useNavigate} from 'react-router'
import {Button,ExMessage} from '@exre/exui'
import {RegistrationEmailForm,InvitationCodeForm,InvitationProfileForm,type InvitationFormHandle,type InvitationFormErrors,type InvitationProfileValues} from '@workspace/components'
import type {components} from '@workspace/api-client'
import {api} from '@web/src/api/client'
import {ExAxiosError} from '@workspace/sdk/http/browser'
import {useThirdPartySignIn,type ThirdPartySignInPresentation} from '@web/src/auth/useThirdPartySignIn'
import {CfxAuthorization} from './CfxAuthorization'
type CfxRegistration=Extract<components['schemas']['CfxSignInResult'],{kind:'registration-required'}>
type Grant=components['schemas']['RegistrationGrant']
interface Props {presentation:'modal'|'page';initialEmail?:string;initialGrant?:CfxRegistration;onLogin?:(email:string)=>void;onJoin?:()=>void;onSessionCreated?:(token:string)=>void}
type Step='email'|'code'|'profile'|'registered'
export function PublicRegistrationFlow({presentation,initialEmail='',initialGrant,onLogin,onSessionCreated}:Props) {
  const navigate=useNavigate(),[step,setStep]=useState<Step>(initialGrant?'profile':'email'),[email,setEmail]=useState(initialGrant?.email??initialEmail)
  const [nickname,setNickname]=useState(initialGrant?.suggestedNickname??''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(false)
  const [resendUntil,setResendUntil]=useState(0),[lockedUntil,setLockedUntil]=useState(0),[clock,setClock]=useState(Date.now())
  const [notice,setNotice]=useState<string|null>(null),[error,setError]=useState<string|null>(null)
  const [cfxActive,setCfxActive]=useState(false)
  const [cfxEpoch,setCfxEpoch]=useState(0)
  const mounted=useRef(false),generation=useRef(0),pending=useRef(false),grant=useRef<Grant|null>(initialGrant??null),challenge=useRef<string|null>(null)
  const cfxVersion=useRef(0)
  const emailForm=useRef<InvitationFormHandle>(null),codeForm=useRef<InvitationFormHandle>(null),profileForm=useRef<InvitationFormHandle>(null)
  const controller=useRef<AbortController|null>(null),finished=useRef(false)
  const thirdParty=useThirdPartySignIn(()=>{
    invalidate(false)
    setEmail('');setNickname('');setLockedUntil(0);setResendUntil(0)
    setStep('email');setCfxEpoch(value=>value+1)
    setNotice('登录状态已变化，请重新开始注册')
  })
  const current=(version:number)=>mounted.current&&generation.current===version
  const cfxPresentation:ThirdPartySignInPresentation={
    onSignedIn:finishInstalledSession,
    onRegistrationRequired:result=>{grant.current=result;setEmail(result.email);setNickname(result.suggestedNickname??'');setStep('profile')},
    onAccountExists:targetEmail=>{setEmail(targetEmail);setNotice('该邮箱已有账号，请登录后在设置中主动关联 Cfx。')},
    onFailure:setError,
  }
  const form=()=>step==='email'?emailForm.current:step==='code'?codeForm.current:profileForm.current
  useEffect(()=>{
    mounted.current=true
    if(presentation==='page') {
      const url=new URL(window.location.href)
      if(url.searchParams.has('code')){setNotice('注册流程已调整，请使用公开注册入口。');url.searchParams.delete('code');window.history.replaceState(window.history.state,'',`${url.pathname}${url.search}${url.hash}`)}
    }
    const timer=setInterval(()=>setClock(Date.now()),1000)
    return()=>{mounted.current=false;clearInterval(timer);controller.current?.abort();generation.current++;queueMicrotask(()=>{if(!mounted.current)grant.current=null})}
  },[])
  function invalidate(invalidateThirdParty=true) {generation.current++;if(invalidateThirdParty)thirdParty.invalidate();controller.current?.abort();controller.current=null;grant.current=null;challenge.current=null;pending.current=false;setBusy(false);setCfxActive(false);setRetry(false);setError(null);form()?.clearServerErrors()}
  function back(){invalidate();setNickname('');setLockedUntil(0);setResendUntil(0);setStep('email')}
  function fail(version:number,issue:unknown,target:'email'|'code'|'profile',operation:'send'|'verify'|'complete') {
    if(!current(version))return
    const code=issue instanceof ExAxiosError?issue.code:''
    const message=code==='EMAIL_IN_USE'?'该邮箱已有账号，请登录':
      code==='REGISTRATION_MAIL_UNAVAILABLE'?'邮件服务暂不可用，请稍后重试或使用 Cfx':
      code==='REGISTRATION_CODE_RESEND_TOO_SOON'?'发送过于频繁，请稍后重新发送':
      code==='REGISTRATION_CODE_INVALID'?'验证码无效或已过期':
      code==='REGISTRATION_CODE_LOCKED'?'验证暂时锁定，请稍后重试':
      code==='REGISTRATION_GRANT_INVALID'||code==='REGISTRATION_RESTART_REQUIRED'?'注册验证已失效，请返回重新验证或授权':
      code==='REGISTRATION_IN_PROGRESS'?'注册正在处理，请稍后重试以读取结果':'操作未完成，请重试'
    if(issue instanceof ExAxiosError&&Number.isFinite(issue.retryAfterSeconds)&&issue.retryAfterSeconds!>0){
      const until=Date.now()+issue.retryAfterSeconds!*1000
      if(operation==='verify'&&code==='REGISTRATION_CODE_LOCKED')setLockedUntil(until)
      else if(operation==='send')setResendUntil(until)
    }
    const errors:InvitationFormErrors=operation==='verify'&&code==='REGISTRATION_CODE_INVALID'?{code:message}:{form:message}
    const handle=target==='email'?emailForm.current:target==='code'?codeForm.current:profileForm.current
    handle?.setServerErrors(errors)
    if(operation==='verify')setRetry(true)
  }
  function cooldown(data:components['schemas']['RegistrationCodeRequested']) {challenge.current=data.challengeId;setResendUntil(Date.now()+Math.max(0,data.resendAvailableAt-data.serverTime))}
  async function send(targetEmail:string,resending=false):Promise<boolean> {
    if(pending.current||Date.now()<lockedUntil||(resending&&Date.now()<resendUntil))return false
    thirdParty.invalidate()
    const version=++generation.current;pending.current=true;setBusy(true);setError(null);form()?.clearServerErrors()
    const abort=new AbortController();controller.current=abort
    try {
      const result=await api.POST('/auth/registration/code',{body:{email:targetEmail},signal:abort.signal,alert:false})
      if(!current(version))return false
      cooldown(result);setEmail(targetEmail);setStep('code');setRetry(false);return true
    }catch(issue){fail(version,issue,resending?'code':'email','send');return false}finally{if(current(version)){pending.current=false;setBusy(false)}}
  }
  async function verify(code:string) {
    if(pending.current||challenge.current===null||Date.now()<lockedUntil)return
    thirdParty.invalidate()
    const version=generation.current;pending.current=true;setBusy(true);setError(null);codeForm.current?.clearServerErrors()
    try {
      const result=await api.POST('/auth/registration/verify',{body:{challengeId:challenge.current,code},signal:controller.current?.signal,alert:false})
      if(!current(version))return
      grant.current=result;setEmail(result.email);setNickname('');setStep('profile');setRetry(false)
    }catch(issue){fail(version,issue,'code','verify')}finally{if(current(version)){pending.current=false;setBusy(false)}}
  }
  function login() {
    if(finished.current)return
    finished.current=true;invalidate()
    if(presentation==='modal')onLogin?.(email)
    else navigate('/login',{replace:true,state:{email}})
  }
  async function complete(values:InvitationProfileValues) {
    const active=grant.current
    if(pending.current||!active)return
    thirdParty.invalidate()
    const version=generation.current;pending.current=true;setBusy(true);setError(null);profileForm.current?.clearServerErrors()
    try {
      await api.POST('/auth/registrations',{body:{registrationToken:active.registrationToken,...values},signal:controller.current?.signal,alert:false})
      if(!current(version))return
      grant.current=null;setNickname('');setStep('registered');ExMessage.info('注册成功，请前往登录')
    }catch(issue){fail(version,issue,'profile','complete')}finally{if(current(version)){pending.current=false;setBusy(false)}}
  }
  async function cfx(ticket:string,_attemptId:string,signal:AbortSignal) {
    const version=++generation.current;cfxVersion.current=version;setError(null)
    await thirdParty.runCfxTicket(ticket,signal,()=>current(version),cfxPresentation)
  }
  function finishInstalledSession(token:string){
    if(onSessionCreated)onSessionCreated(token)
    else if(presentation==='modal')window.location.reload()
    else window.location.replace('/')
  }
  async function retryCfxInstallation(){
    const version=cfxVersion.current
    await thirdParty.retrySessionInstallation(()=>current(version),cfxPresentation)
  }
  useEffect(()=>{if(step!=='registered')return;const timer=setTimeout(login,1500);return()=>clearTimeout(timer)},[step])
  return <>
    {notice&&<p role="status">{notice}</p>}
    {step==='email'&&<>
      <RegistrationEmailForm ref={emailForm} initialEmail={email} busy={busy||cfxActive||thirdParty.busy} onSubmit={async value=>{await send(value)}} onEmailChange={invalidate} onLogin={login}/>
      <CfxAuthorization key={cfxEpoch} disabled={busy||thirdParty.busy} onActiveChange={setCfxActive} onTicket={cfx}/><Button type="button" disabled>Google 暂未开放</Button><Button type="button" disabled>QQ 暂未开放</Button>
    </>}
    {step==='code'&&<InvitationCodeForm ref={codeForm} email={email} busy={busy} retry={retry} resendSeconds={Math.max(0,Math.ceil((resendUntil-clock)/1000))} lockedSeconds={Math.max(0,Math.ceil((lockedUntil-clock)/1000))} onVerify={verify} onResend={()=>send(email,true)} onBack={back}/>}
    {step==='profile'&&<InvitationProfileForm key={email} ref={profileForm} email={email} nickname={nickname} busy={busy} onSubmit={complete} onBack={back}/>}
    {step==='registered'&&<section aria-live="polite"><h2>注册成功</h2><p>账号已创建，即将前往登录。</p><Button type="button" onClick={login}>前往登录</Button></section>}
    {error&&<p role="alert">{error}</p>}
    {thirdParty.outcome?.kind==='failed'&&thirdParty.outcome.retryInstallation&&<Button type="button" disabled={thirdParty.busy} onClick={()=>void retryCfxInstallation()}>重试完成登录</Button>}
  </>
}
