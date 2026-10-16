import {useEffect,useRef,useState} from 'react'
import {Button} from '@exre/exui'
import {CfxPayloadForm} from '@workspace/components'
import type {components} from '@workspace/api-client'
import {api} from '@web/src/api/client'
import {ExAxiosError} from '@workspace/sdk/http/browser'
type Attempt=components['schemas']['CfxAttemptCreated']
interface Props {
  token?:string
  disabled?:boolean
  onActiveChange?:(active:boolean)=>void
  onTicket:(ticket:string,attemptId:string,signal:AbortSignal)=>Promise<void>
}
export function CfxAuthorization({token,disabled=false,onActiveChange,onTicket}:Props) {
  const [attempt,setAttempt]=useState<Attempt|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const generation=useRef(0),mounted=useRef(false),attemptRef=useRef<Attempt|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const controller=useRef<AbortController|null>(null),polling=useRef(false),creating=useRef(false)
  const manualCompleted=useRef(false)
  const retryAt=useRef(0)
  const headers=token?{Authorization:`Bearer ${token}`} : undefined
  const current=(version:number)=>mounted.current&&generation.current===version
  const clearTimer=()=>{if(timer.current!==undefined)clearTimeout(timer.current);timer.current=undefined}
  const cancelAttempt=(id:string)=>api.DELETE('/auth/cfx/attempts/{id}',{params:{path:{id}},alert:false}).catch(()=>undefined)
  function stop(update=true) {
    generation.current++;clearTimer();controller.current?.abort();controller.current=null;polling.current=false;manualCompleted.current=false;retryAt.current=0
    const old=attemptRef.current;attemptRef.current=null
    if(old)void cancelAttempt(old.attemptId)
    if(update){setAttempt(null);setBusy(creating.current);setError(null);onActiveChange?.(false)}
  }
  useEffect(()=>{
    mounted.current=true;setAttempt(null);setBusy(false)
    const visible=()=>{const active=attemptRef.current;if(active&&(active.mode==='redirect'||manualCompleted.current)&&document.visibilityState==='visible')void poll(generation.current);else clearTimer()}
    document.addEventListener('visibilitychange',visible)
    return()=>{mounted.current=false;document.removeEventListener('visibilitychange',visible);stop(false)}
  },[token])
  function failed(version:number,issue:unknown) {
    if(!current(version))return
    const text=issue instanceof ExAxiosError&&issue.code==='CFX_DISABLED'?'Cfx 暂未开放，请使用邮箱和密码':
      issue instanceof ExAxiosError&&issue.code==='IDENTITY_LINK_CONFLICT'?'Cfx 身份已有其他关联；请先解除已有的关联，或使用其他 Cfx 身份':
      issue instanceof ExAxiosError&&issue.code==='CFX_CAPACITY_EXCEEDED'?'Cfx 授权繁忙，请稍后重试':'Cfx 授权未完成，请重新开始'
    stop();setError(text)
  }
  async function begin() {
    if(disabled||creating.current||attemptRef.current)return
    const version=++generation.current;creating.current=true;setBusy(true);setError(null);onActiveChange?.(true)
    const abort=new AbortController();controller.current=abort
    try {
      const result=token?await api.POST('/auth/me/identity-links/cfx/attempts',{body:{},headers,signal:abort.signal,alert:false})
        :await api.POST('/auth/cfx/attempts',{body:{},signal:abort.signal,alert:false})
      if(!current(version)){void cancelAttempt(result.attemptId);return}
      attemptRef.current=result;setAttempt(result);setBusy(false)
      if(result.mode==='redirect'){
        window.open(result.authorizationUrl,'_blank','noopener,noreferrer')
        void poll(version)
      }
    } catch(issue){failed(version,issue)}finally{creating.current=false;if(mounted.current&&!attemptRef.current&&!polling.current)setBusy(false)}
  }
  async function poll(version:number) {
    const active=attemptRef.current
    if(!active||!current(version)||polling.current||document.visibilityState!=='visible')return
    clearTimer()
    // Visibility changes may clear the timer without ending the server's retry window.
    const remaining=retryAt.current-Date.now()
    if(remaining>0){timer.current=setTimeout(()=>void poll(version),remaining);return}
    retryAt.current=0
    polling.current=true
    try {
      // Ready results have their own lifetime; the server owns expiry.
      const status=await api.GET('/auth/cfx/attempts/{id}',{params:{path:{id:active.attemptId}},signal:controller.current?.signal,alert:false})
      if(!current(version))return
      if(status.state==='ready'){
        setBusy(true)
        await onTicket(status.identityTicket,status.attemptId,controller.current!.signal)
        if(!current(version))return
        attemptRef.current=null;setAttempt(null);setBusy(false);onActiveChange?.(false)
      } else if(status.state==='pending'||status.state==='processing'){
        timer.current=setTimeout(()=>void poll(version),1000)
      } else failed(version,null)
    } catch(issue){
      if(!current(version))return
      if(issue instanceof ExAxiosError&&issue.code==='CFX_REQUEST_LIMITED'){
        const seconds=issue.retryAfterSeconds
        const delay=seconds!==undefined&&Number.isFinite(seconds)&&seconds>0?seconds*1000:1000
        retryAt.current=Date.now()+delay
        timer.current=setTimeout(()=>void poll(version),delay)
      } else failed(version,issue)
    } finally{if(current(version))polling.current=false}
  }
  async function manual(payload:string) {
    const active=attemptRef.current,version=generation.current
    if(!active||busy||manualCompleted.current||active.mode!=='manual')return
    setBusy(true);setError(null)
    try {
      await api.POST('/auth/cfx/attempts/{id}/complete',{params:{path:{id:active.attemptId}},body:{payload},signal:controller.current?.signal,alert:false})
      if(!current(version))return
      manualCompleted.current=true
      await poll(version)
    } catch(issue){failed(version,issue)}finally{if(current(version)&&!manualCompleted.current)setBusy(false)}
  }
  return <section aria-label="Cfx 授权">
    {!attempt&&<Button type="button" variant="outline" disabled={busy||disabled} onClick={()=>void begin()}>使用 Cfx</Button>}
    {(attempt||busy)&&<Button type="button" variant="ghost" onClick={()=>stop()}>取消 Cfx 授权</Button>}
    {attempt&&<>
      <p>在 Cfx 页面授权后返回此处。</p>
      <Button type="button" variant="link" onClick={()=>window.open(attempt.authorizationUrl,'_blank','noopener,noreferrer')}>打开授权页面</Button>
      {attempt.mode==='manual'?<CfxPayloadForm busy={busy} onSubmit={manual}/>:<p role="status">正在等待授权结果，请保留此页面。</p>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>
}
