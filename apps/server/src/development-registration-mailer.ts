import type {RegistrationMailer} from './modules/registration/service.js'
export interface DevelopmentRegistrationMail {
  channel:'registration-mail:development';recipient:string;code:string;codeExpiresAt:number;attemptId:string
}
export class RegistrationMailConfigurationError extends Error {
  constructor(){super('SERVER_REGISTRATION_MAIL_SIMULATOR requires development mode.')}
}
/** Explicit development channel only; never used by the HTTP/request logger or a production adapter. */
export function developmentRegistrationMailer(environment:Record<string,string|undefined>,
  emit:(mail:DevelopmentRegistrationMail)=>Promise<void> = mail=>new Promise((resolve,reject)=>{
    process.stderr.write(`[registration-mail:development] ${JSON.stringify(mail)}\n`,error=>error?reject(error):resolve())
  })):RegistrationMailer|undefined {
  const value=environment.SERVER_REGISTRATION_MAIL_SIMULATOR
  if(value!==undefined&&value!=='true'&&value!=='false')throw new RegistrationMailConfigurationError()
  if(value!=='true')return undefined
  if(environment.NODE_ENV!=='development')throw new RegistrationMailConfigurationError()
  return {async send(mail){
    if(mail.signal.aborted)throw new Error('Development registration mail cancelled.')
    await emit({channel:'registration-mail:development',recipient:mail.recipient,code:mail.code,
      codeExpiresAt:mail.codeExpiresAt,attemptId:mail.attemptId})
  }}
}
