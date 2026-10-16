import {forwardRef,useId,useImperativeHandle} from 'react'
import {useForm} from 'react-hook-form'
import {zodResolver} from '@hookform/resolvers/zod'
import {z} from 'zod'
import {Button,Field,FieldContent,FieldError,FieldLabel,Input} from '@exre/exui'
import {invitationEmailSchema} from './InvitationForms'
import type {InvitationFormHandle} from './invitationFeedback'
import {ErrorPanel} from '../ErrorPanel'
import styles from './AuthForm.module.scss'
const schema=z.object({email:invitationEmailSchema})
interface Props {initialEmail:string;busy:boolean;onSubmit:(email:string)=>Promise<void>;onEmailChange:()=>void;onLogin:()=>void}
export const RegistrationEmailForm=forwardRef<InvitationFormHandle,Props>(function RegistrationEmailForm({initialEmail,busy,onSubmit,onEmailChange,onLogin},ref){
  const id=useId(),form=useForm({resolver:zodResolver(schema),defaultValues:{email:initialEmail}})
  useImperativeHandle(ref,()=>({setServerErrors:errors=>{
    if(errors.email)form.setError('email',{message:errors.email})
    if(errors.form)form.setError('root.server',{message:errors.form})
  },clearServerErrors:()=>form.clearErrors()}))
  const email=form.register('email'),disabled=busy||form.formState.isSubmitting
  return <form className={`${styles.form} ${styles.loginForm}`} onSubmit={form.handleSubmit(({email})=>onSubmit(email))} noValidate aria-busy={disabled}>
    <div className={`${styles.intro} ${styles.loginIntro}`}><h2>注册 Exre 账号</h2><p>创建平台账号后，可以申请加入社区。</p></div>
    <Field data-invalid={!!form.formState.errors.email}><FieldContent><FieldLabel htmlFor={id}>邮箱</FieldLabel>
      <Input {...email} onChange={event=>{email.onChange(event);form.clearErrors();onEmailChange()}} id={id} type="email" autoComplete="email" autoFocus disabled={disabled} aria-invalid={!!form.formState.errors.email} aria-describedby={form.formState.errors.email?`${id}-error`:undefined}/>
      {form.formState.errors.email&&<FieldError id={`${id}-error`}>{form.formState.errors.email.message}</FieldError>}
    </FieldContent></Field>
    {form.formState.errors.root?.server?.message&&<ErrorPanel errors={[{id:'registration',message:form.formState.errors.root.server.message}]}/>}
    <Button type="submit" disabled={disabled}>{disabled?'发送中':'继续'}</Button>
    <Button type="button" variant="link" onClick={onLogin}>已经有账号？登录</Button>
  </form>
})
