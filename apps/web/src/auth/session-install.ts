import {revokePreviousSessionForReplacement} from '@web/src/api/client'
import {ExAxiosError} from '@workspace/sdk/http/browser'
import {readToken,removeMatchingToken,writeToken} from './storage'
export type SessionInstallation = {status:'installed'}|{status:'stale'}|{status:'failed';message:string}
/** Ordinary password and Cfx login share the same old-session and storage ownership checks. */
export async function installBrowserSession(token:string,isCurrent:()=>boolean):Promise<SessionInstallation> {
  if(!isCurrent())return {status:'stale'}
  let oldToken:string|null
  try {oldToken=readToken(window.localStorage)}catch{return {status:'failed',message:'浏览器无法读取登录信息，请检查存储设置后重试'}}
  if(oldToken!==null&&oldToken!==token) {
    try {
      await revokePreviousSessionForReplacement(oldToken)
      if(!isCurrent()){
        try{removeMatchingToken(window.localStorage,oldToken)}catch{/* storage may already be unavailable */}
        return {status:'stale'}
      }
    } catch(issue) {
      if(!isCurrent())return {status:'stale'}
      if(!(issue instanceof ExAxiosError&&issue.code==='SESSION_INVALID'))return {status:'failed',message:'旧账号退出失败，请重试登录'}
      try {if(readToken(window.localStorage)===null)oldToken=null}catch{return {status:'failed',message:'浏览器无法读取登录信息，请检查存储设置后重试'}}
    }
  }
  if(!isCurrent())return {status:'stale'}
  try {
    if(readToken(window.localStorage)!==oldToken)return {status:'failed',message:'登录状态已在其他页面更改，请重试'}
    writeToken(window.localStorage,token)
  }catch{return {status:'failed',message:'浏览器无法保存登录信息，请检查存储设置后重试'}}
  return {status:'installed'}
}
