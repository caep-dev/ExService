import {useId} from 'react'
import {useForm} from 'react-hook-form'
import {zodResolver} from '@hookform/resolvers/zod'
import {z} from 'zod'
import {Button,Field,FieldContent,FieldError,FieldLabel,Textarea} from '@exre/exui'
const schema=z.object({payload:z.string().trim().min(1,'请粘贴加密授权结果').max(1024,'授权结果过长')})
export function CfxPayloadForm({busy,onSubmit}:{busy:boolean;onSubmit:(payload:string)=>Promise<void>}) {
  const id=useId(),form=useForm({resolver:zodResolver(schema),defaultValues:{payload:''}})
  return <form onSubmit={form.handleSubmit(async({payload})=>{await onSubmit(payload);form.reset()})} noValidate aria-busy={busy}>
    <Field data-invalid={!!form.formState.errors.payload}><FieldContent><FieldLabel htmlFor={id}>加密授权结果</FieldLabel>
      <Textarea {...form.register('payload')} id={id} disabled={busy} autoComplete="off" spellCheck={false} aria-invalid={!!form.formState.errors.payload} aria-describedby={form.formState.errors.payload?`${id}-error`:undefined}/>
      {form.formState.errors.payload&&<FieldError id={`${id}-error`}>{form.formState.errors.payload.message}</FieldError>}
    </FieldContent></Field>
    <Button type="submit" disabled={busy||form.formState.isSubmitting}>完成 Cfx 授权</Button>
  </form>
}
