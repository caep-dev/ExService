import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Alert, AlertDescription, Avatar, AvatarFallback, AvatarImage, Button, Dialog,
  DialogContent, DialogDescription, DialogHeader, DialogTitle, Field, FieldContent,
  FieldError, FieldLabel, Input, SelectContent, SelectField, SelectItem,
  SelectSeparator, SelectTrigger, SelectValue, Spinner,
} from '@exre/exui'
import { ChevronRight, Menu } from 'lucide-react'
import Cropper, { type Area, type MediaSize, type Size } from 'react-easy-crop'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { avatarSchema, fivemIdSchema, nicknameSchema, qqSchema } from '@components/src/profileValidation'
import { cropAvatar, minimumAvatarZoom } from '@components/src/avatarCrop'
import { ContentAreaState, SettingsContentSkeleton } from '@components/src/ContentAreaState'
import {
  NotificationPreferencesForm,
  type NotificationPreferencesDraft, type PreferenceFormBinding, type PreferenceSaveFailure,
} from '@components/src/notifications/NotificationPreferencesForm'
import styles from '@components/src/SettingsPanel.module.scss'

export type SettingsCategory = 'general' | 'profile' | 'account' | 'notifications' | 'identity-links'
export type SettingsTheme = 'light' | 'dark' | 'system'
export type SettingsField = 'nickname' | 'qq' | 'fivemId'

/**
 * 通知分区的独立切片。
 *
 * 它**刻意不与资料共享状态**：资料读取/保存失败不能阻塞通知分区，反之亦然。
 * 共享组件只收 props/callback，规范快照、revision、单写锁、冲突恢复与失败重试意图
 * 都在 `apps/web` 的偏好 module。
 *
 * 与 `PreferenceFormBinding` 是同一套命令语义，只是保留设置面板原有的
 * `preferences` 字段名；`SettingsPanel` 负责把它映射成表单的 `saved`。
 */
export interface SettingsNotificationsSlice extends PreferenceFormBinding {
  /**
   * 身份代次：换号/退出时递增，隔离表单值与在途即时保存。
   */
  identityEpoch: number
  preferences: NotificationPreferencesDraft | null
}

export interface SettingsPanelProps {
  category: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
  theme: SettingsTheme
  onThemeChange: (theme: SettingsTheme) => void
  profile: { email: string; nickname: string; qq: string | null; fivemId: string | null; avatarUrl: string | null } | null
  profileStatus: 'idle' | 'loading' | 'ready' | 'error'
  profileError: string | null
  onRetry: () => void
  notifications: SettingsNotificationsSlice
  onSave: (field: SettingsField, value: string) => Promise<void>
  onUpload: (file: Blob) => Promise<void>
  onRemoveAvatar: () => Promise<void>
  onLogout: () => void
  logoutPending: boolean
  actionPending: boolean
  authMessage?: string
  onRetryAuth?: () => void
  identityLinks?: ReactNode
}

const categories: { value: SettingsCategory; label: string }[] = [
  { value: 'profile', label: '个人资料' }, { value: 'general', label: '通用' },
  { value: 'notifications', label: '通知' }, { value: 'account', label: '账号' },
  {value:'identity-links',label:'关联账户'},
]

export function SettingsPanel(props: SettingsPanelProps) {
  const profile = props.profile
  return <div className={styles.panel}>
    <div className={styles.sidebar}>
      <nav className={styles.navigation} aria-label="设置分类">
        {categories.map(({ value, label }) => <Button key={value} type="button"
          variant={props.category === value ? 'secondary' : 'ghost'}
          aria-current={props.category === value ? 'page' : undefined}
          onClick={() => props.onCategoryChange(value)}>{label}</Button>)}
      </nav>
      <Button className={styles.logoutAction} type="button" variant="ghost"
        disabled={props.logoutPending} onClick={props.onLogout}>
        {props.logoutPending ? <Spinner aria-hidden="true" /> : null}退出登录
      </Button>
    </div>
    <header className={styles.mobileNavigation}>
      <SelectField value={props.category} onValueChange={(value) => {
        if (value === 'logout') props.onLogout()
        else if (value === 'profile' || value === 'general' || value === 'account'
          || value === 'notifications' || value === 'identity-links') {
          props.onCategoryChange(value)
        }
      }}>
        <SelectTrigger className={styles.mobileCategoryTrigger} aria-label="选择设置页面">
          <Menu aria-hidden="true" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {categories.map(({ value, label }) =>
            <SelectItem key={value} value={value}>{label}</SelectItem>)}
          <SelectSeparator />
          <SelectItem className={styles.mobileLogoutOption} value="logout"
            disabled={props.logoutPending}>退出登录</SelectItem>
        </SelectContent>
      </SelectField>
      <h2 className={styles.mobileTitle}>{categories.find(({ value }) => value === props.category)?.label}</h2>
    </header>
    <div className={styles.content}>
      {/* 认证提示只依赖共享认证状态：通知分区不能因为资料没读到就不显示它。 */}
      {props.authMessage && (props.category === 'general' || props.category === 'notifications' ||
        (props.profileStatus === 'ready' && profile)) && <Alert variant="destructive" role="alert">
        <AlertDescription>{props.authMessage}</AlertDescription>
        {props.onRetryAuth && <Button type="button" onClick={props.onRetryAuth}>重试登录状态</Button>}
      </Alert>}
      {/*
        按分类**先选来源再选内容门控**：general 只看主题；notifications 只看通知切片；
        profile/account 共用资料来源。这是分区失败隔离的前提，不是「追加一个分类名」。
      */}
      {props.category === 'general' ? <ContentAreaState status="ready">
        <header className={styles.contentHeader}><h2>通用</h2></header>
        <section className={styles.group} aria-label="外观">
          <h3>外观</h3>
          <SettingItem label="网站主题" description="选择网站的显示主题。">
            <SelectField value={props.theme}
              onValueChange={(value) => {
                if (value === 'light' || value === 'dark' || value === 'system') props.onThemeChange(value)
              }}>
              <SelectTrigger className={styles.themeSelect} aria-label="网站主题">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
                <SelectItem value="system">跟随系统</SelectItem>
              </SelectContent>
            </SelectField>
          </SettingItem>
        </section>
      </ContentAreaState> : props.category === 'identity-links' ? props.identityLinks : props.category === 'notifications' ? null
        : props.profileStatus === 'ready' && profile ? <ContentAreaState status="ready">
          {props.category === 'profile' ? <ProfileContent {...props} profile={profile} /> :
            <AccountContent {...props} profile={profile} />}
        </ContentAreaState> : props.profileStatus === 'error' ? <ContentAreaState status="error"
          errorMessage={props.profileError ?? '无法读取设置资料'} onRetry={props.onRetry} /> :
          <ContentAreaState status="loading" skeleton={<SettingsContentSkeleton profile={props.category === 'profile'} />} />}
      {/*
        通知表单始终挂载：分类只控制可见性，保存请求与失败重试意图保持同一个身份所有者。
        加载/失败/重试三态由表单自己按通知来源渲染，不共用资料门控。
      */}
      <NotificationPreferencesForm active={props.category === 'notifications'}
        identityEpoch={props.notifications.identityEpoch}
        saved={props.notifications.preferences}
        status={props.notifications.status}
        saving={props.notifications.saving}
        conflict={props.notifications.conflict}
        failure={props.notifications.failure}
        onRetryRead={props.notifications.onRetryRead}
        onSaveField={props.notifications.onSaveField}
        />
    </div>
  </div>
}

type ReadyProps = SettingsPanelProps & { profile: NonNullable<SettingsPanelProps['profile']> }

function ProfileContent(props: ReadyProps) {
  const [editField, setEditField] = useState<'nickname' | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  const avatarTrigger = useRef<HTMLButtonElement | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const closeEdit = () => { setEditField(null); requestAnimationFrame(() => editTrigger.current?.focus()) }
  const closeUpload = () => { setUploadOpen(false); requestAnimationFrame(() => avatarTrigger.current?.focus()) }
  const closeCrop = () => { setCropFile(null); requestAnimationFrame(() => avatarTrigger.current?.focus()) }
  const removeAvatar = async () => {
    setRemoving(true); setRemoveError(null)
    try { await props.onRemoveAvatar(); closeUpload() }
    catch (error) { setRemoveError(message(error, '移除头像失败')) }
    finally { setRemoving(false) }
  }

  return <>
    <header className={styles.contentHeader}><h2>个人资料</h2></header>
    <section className={styles.profileHero} aria-label="公开资料">
      <Button ref={avatarTrigger} className={styles.avatarTrigger} type="button" variant="ghost"
        aria-label="编辑头像" disabled={props.actionPending}
        onClick={() => { setRemoveError(null); setUploadOpen(true) }}>
        <Avatar className={`${styles.avatar} ex-glass`}>
          {props.profile.avatarUrl && <AvatarImage src={props.profile.avatarUrl} alt="当前头像" />}
          <AvatarFallback className={styles.avatarFallback}>
            {Array.from(props.profile.nickname)[0] ?? '?'}
          </AvatarFallback>
        </Avatar>
      </Button>
      <Button ref={editTrigger} className={styles.profileName} type="button" variant="ghost"
        aria-label="编辑用户名" onClick={() => setEditField('nickname')}>
        <span>{props.profile.nickname}</span><ChevronRight aria-hidden="true" />
      </Button>
    </section>
    {uploadOpen && <AvatarUploadDialog hasAvatar={Boolean(props.profile.avatarUrl)}
      disabled={props.actionPending || Boolean(props.authMessage)} removing={removing}
      removeError={removeError} onClose={closeUpload} onRemove={() => void removeAvatar()}
      onSelect={(file) => { setUploadOpen(false); setCropFile(file) }} />}
    {editField && <EditDialog field={editField}
      initial={props.profile[editField] ?? ''} onClose={closeEdit}
      onSave={props.onSave} disabled={props.actionPending || Boolean(props.authMessage)} />}
    {cropFile && <CropDialog file={cropFile} onClose={closeCrop}
      onUpload={props.onUpload} disabled={props.actionPending || Boolean(props.authMessage)} />}
  </>
}

function AvatarUploadDialog({ hasAvatar, disabled, removing, removeError, onClose, onRemove, onSelect }: {
  hasAvatar: boolean; disabled: boolean; removing: boolean; removeError: string | null
  onClose: () => void; onRemove: () => void; onSelect: (file: File) => void
}) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const imageForm = useForm<{ image: FileList }>({ resolver: zodResolver(avatarSchema) })
  const imageInput = imageForm.register('image')
  const selectImage = imageForm.handleSubmit(({ image }) => {
    const file = image.item(0)
    if (file) onSelect(file)
  })
  return <Dialog open onOpenChange={(open) => { if (!open && !removing) onClose() }}>
    <DialogContent className={styles.uploadDialog}>
      <DialogHeader><DialogTitle>上传头像</DialogTitle>
        <DialogDescription>选择 PNG、JPEG 或 WebP 图片，裁剪后上传。</DialogDescription></DialogHeader>
      <form noValidate className={styles.uploadForm}>
        <Field data-invalid={imageForm.formState.errors.image ? true : undefined}>
          <FieldContent><FieldLabel className={styles.visuallyHidden} htmlFor={`${id}-image`}>头像图片</FieldLabel>
            <Input id={`${id}-image`} type="file" accept="image/png,image/jpeg,image/webp"
              {...imageInput} ref={(element) => { imageInput.ref(element); fileInput.current = element }}
              onChange={async (event) => { await imageInput.onChange(event); await selectImage() }}
              className={styles.visuallyHidden}
              aria-invalid={imageForm.formState.errors.image ? true : undefined} />
            {imageForm.formState.errors.image && <FieldError>{imageForm.formState.errors.image.message}</FieldError>}
          </FieldContent>
        </Field>
        {removeError && <p role="alert">{removeError}</p>}
        <div className={styles.rowActions}>
          {hasAvatar && <Button className={styles.removeAvatarAction} type="button" variant="ghost"
            disabled={disabled || removing} onClick={onRemove}>移除头像</Button>}
          <Button type="button" variant="outline" disabled={removing} onClick={onClose}>取消</Button>
          <Button type="button" disabled={disabled || removing}
            onClick={() => fileInput.current?.click()}>选择图片</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}

function AccountContent(props: ReadyProps) {
  const [editField, setEditField] = useState<'qq' | 'fivemId' | null>(null)
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  return <>
    <header className={styles.contentHeader}><h2>账号</h2></header>
    <section className={styles.group} aria-label="登录信息"><h3>登录信息</h3>
      <SettingItem label="邮箱" description="当前不可修改邮箱。">
        <span className={styles.readonlyValue}>{props.profile.email}</span>
      </SettingItem>
    </section>
    <section className={styles.group} aria-label="关联信息"><h3>关联信息</h3>
      <SettingRow label="QQ" value={props.profile.qq ?? '未设置'} onEdit={(trigger) => {
        editTrigger.current = trigger; setEditField('qq') }} />
      <SettingRow label="FiveM ID" description="未验证。此信息由用户手填，不用于身份认证、社区组归属或权限判断。"
        value={props.profile.fivemId ?? '未设置'} onEdit={(trigger) => {
        editTrigger.current = trigger; setEditField('fivemId') }} />
    </section>
    {editField && <EditDialog field={editField} initial={props.profile[editField] ?? ''}
      onClose={() => { setEditField(null); requestAnimationFrame(() => editTrigger.current?.focus()) }} onSave={props.onSave}
      disabled={props.actionPending || Boolean(props.authMessage)} />}
  </>
}

function SettingItem({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className={styles.item}>
    <div className={styles.itemText}><span className={styles.itemLabel}>{label}</span>
      {description && <p>{description}</p>}</div>
    <div className={styles.itemControl}>{children}</div>
  </div>
}

function SettingRow({ label, description, value, onEdit }: { label: string; description?: string; value: string;
  onEdit: (trigger: HTMLButtonElement) => void }) {
  return <SettingItem label={label} description={description}>
    <Button className={styles.valueAction} type="button" variant="ghost" aria-label={`编辑${label}`}
      onClick={(event) => onEdit(event.currentTarget)}><span>{value}</span><ChevronRight aria-hidden="true" /></Button>
  </SettingItem>
}

function EditDialog({ field, initial, onClose, onSave, disabled }: {
  field: SettingsField; initial: string; onClose: () => void
  onSave: SettingsPanelProps['onSave']; disabled: boolean
}) {
  const label = field === 'nickname' ? '用户名' : field === 'qq' ? 'QQ' : 'FiveM ID'
  const schema = z.object({ value: field === 'nickname' ? nicknameSchema : field === 'qq' ? qqSchema : fivemIdSchema })
  const form = useForm<{ value: string }>({ resolver: zodResolver(schema), defaultValues: { value: initial } })
  const id = useId()
  const submit = form.handleSubmit(async ({ value }) => {
    form.clearErrors('root.server')
    try { await onSave(field, value); onClose() }
    catch (error) { form.setError('root.server', { message: message(error, '保存失败') }) }
  })
  return <Dialog open onOpenChange={(open) => { if (!open && !form.formState.isSubmitting) onClose() }}>
    <DialogContent className={styles.editDialog}>
      <DialogHeader><DialogTitle>编辑{label}</DialogTitle>
        <DialogDescription>保存后更新你的设置资料。</DialogDescription></DialogHeader>
      <form onSubmit={submit} noValidate className={styles.editForm}>
        <Field data-invalid={form.formState.errors.value ? true : undefined}><FieldContent>
          <FieldLabel className={field === 'qq' ? styles.qqLabel : undefined}
            htmlFor={`${id}-value`}>{label}</FieldLabel>
          <Input id={`${id}-value`} inputMode={field === 'qq' ? 'numeric' : undefined}
            {...form.register('value')}
            aria-invalid={form.formState.errors.value ? true : undefined} />
          {form.formState.errors.value && <FieldError>{form.formState.errors.value.message}</FieldError>}
        </FieldContent></Field>
        {form.formState.errors.root?.server && <p role="alert">{form.formState.errors.root.server.message}</p>}
        <div className={styles.rowActions}>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={disabled || form.formState.isSubmitting}>保存</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}

function CropDialog({ file, onClose, onUpload, disabled }: {
  file: File; onClose: () => void; onUpload: (image: Blob) => Promise<void>; disabled: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [minZoom, setMinZoom] = useState(1)
  const [mediaSize, setMediaSize] = useState<MediaSize | null>(null)
  const [cropSize, setCropSize] = useState<Size | null>(null)
  const [area, setArea] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  useEffect(() => {
    if (!mediaSize || !cropSize) return
    const minimum = minimumAvatarZoom(mediaSize, cropSize)
    const maximum = Math.max(3, minimum * 3)
    setMinZoom(minimum)
    setZoom((current) => Math.min(Math.max(current, minimum), maximum))
  }, [mediaSize, cropSize])
  const save = async () => {
    if (!url || !area || saving) return
    setSaving(true); setError(null)
    try { await onUpload(await cropAvatar(url, area)); onClose() }
    catch (cause) { setError(message(cause, '头像上传失败')) }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent className={styles.cropDialog}>
      <DialogHeader><DialogTitle>裁剪头像</DialogTitle>
        <DialogDescription>拖动并缩放图片，预览最终正方形范围。</DialogDescription></DialogHeader>
      <div className={styles.cropArea}>{url && <Cropper image={url} crop={crop}
        zoom={zoom} minZoom={minZoom} maxZoom={Math.max(3, minZoom * 3)} aspect={1}
        onCropChange={setCrop} onZoomChange={setZoom}
        setMediaSize={setMediaSize} setCropSize={setCropSize}
        onCropComplete={(_, pixels) => setArea(pixels)} />}</div>
      <label htmlFor="avatar-zoom">缩放</label>
      <input className={styles.zoomSlider} type="range" id="avatar-zoom" min={minZoom}
        max={Math.max(3, minZoom * 3)} step={0.01} value={zoom}
        onChange={(event) => setZoom(Number(event.currentTarget.value))} />
      {error && <p role="alert">{error}</p>}
      <div className={styles.rowActions}>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>取消</Button>
        <Button type="button" onClick={() => void save()} disabled={!url || !area || disabled || saving}>
          {saving && <Spinner aria-hidden="true" />}确认并上传</Button>
      </div>
    </DialogContent>
  </Dialog>
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
