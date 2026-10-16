/**
 * `@workspace/components` 的公开入口。
 *
 * 与 `@workspace/api-client` 一致：本包以**源码形式**导出（`exports` 直接指向 `src/index.ts`），
 * 由消费方的打包器（Vite）编译，因此没有自己的构建步骤。
 *
 * 公开站点组件与可复用的 `ExIcon`；`Logo` / `ThemeToggle` 仍是包内模块。
 *
 * 样式由组件各自的 `.module.scss` 携带，消费方无需额外导入。
 * 但 `@exre/exui/style.css` **不在**本包内导入：ExUI 要求每个应用只导入一次，
 * 该导入点在 `apps/web/src/main.tsx`。
 */
export { SiteHeader } from '@components/src/SiteHeader'
export { ClickUpFieldInput } from './forms/ClickUpFieldInput'
export type { ClickUpFieldInputProps, ClickUpFieldDefinition } from './forms/ClickUpFieldInput'
export { FileUploader, acceptsFile } from './forms/FileUploader'
export type { FileUploaderProps } from './forms/FileUploader'
export { CodeBlock } from './content/CodeBlock'
export { Callout, ContentImage, ContentProse } from './content/Content'
export type { ContentImageProps } from './content/Content'
export { ExIcon } from '@components/src/ExIcon'
export type { ExIconProps } from '@components/src/ExIcon'
export type { SiteHeaderProps } from '@components/src/SiteHeader'
export { AuthArea } from '@components/src/AuthArea'
export type { AuthAreaProps, AuthDisplayState } from '@components/src/AuthArea'
export { ProfileEditor } from '@components/src/ProfileEditor'
export type { ProfileEditorProps, ProfileTextValues } from '@components/src/ProfileEditor'
export { ContentAreaState, SettingsContentSkeleton } from '@components/src/ContentAreaState'
export type { ContentAreaStateProps } from '@components/src/ContentAreaState'
export { ErrorPanel } from '@components/src/ErrorPanel'
export type { ErrorPanelItem, ErrorPanelProps } from '@components/src/ErrorPanel'
export { SettingsPanel } from '@components/src/SettingsPanel'
export type {
  SettingsPanelProps, SettingsCategory, SettingsTheme, SettingsField, SettingsNotificationsSlice,
} from '@components/src/SettingsPanel'

// 持久通知：共享 UI 只收 props/callback，API 与状态归 `apps/web`。
export { NotificationBell } from '@components/src/notifications/NotificationBell'
export type { NotificationBellProps, NotificationPopupStatus } from '@components/src/notifications/NotificationBell'
export { NotificationBody, hasRenderableNotificationBody } from '@components/src/notifications/NotificationBody'
export type { NotificationBodyProps } from '@components/src/notifications/NotificationBody'
export { NotificationItemList } from '@components/src/notifications/NotificationItemList'
export type { NotificationItemListProps } from '@components/src/notifications/NotificationItemList'
export { NotificationHistoryModal } from '@components/src/notifications/NotificationHistoryModal'
export type {
  NotificationHistoryModalProps, NotificationAsyncStatus, NotificationListSlice,
  NotificationDetailSlice, NotificationBulkSlice,
  NotificationConfirmSlice,
} from '@components/src/notifications/NotificationHistoryModal'
export { NotificationPreferencesForm } from '@components/src/notifications/NotificationPreferencesForm'
export type {
  NotificationPreferencesFormProps, NotificationPreferencesDraft, PreferenceCanonicalValues,
  PreferenceField, PreferenceFormBinding, PreferenceSaveFailure,
} from '@components/src/notifications/NotificationPreferencesForm'
export {
  parseNotificationContent, NOTIFICATION_CONTENT_POLICY_VERSION, NOTIFICATION_CONTENT_SCHEMA_VERSION,
} from '@components/src/notifications/notificationContent'
export type {
  NotificationContentInput, SafeContentNode, SafeElementNode, SafeTextNode, SafeContentTag,
} from '@components/src/notifications/notificationContent'
export {
  formatNotificationTime, formatUnreadBadge, isNotificationUnread,
  notificationActionReasonLabel, notificationCategoryLabel, notificationStateLabel,
} from '@components/src/notifications/notificationsView'
export type {
  NotificationActionView, NotificationCategory, NotificationCountState,
  NotificationDetailView, NotificationHistoryFilter, NotificationItemView, NotificationLifecycle,
  NotificationNecessity, NotificationScope, NotificationActionUnavailableReason,
} from '@components/src/notifications/notificationsView'
export { AuthForm } from '@components/src/auth/AuthForm'
export type {
  AuthFormErrors,
  AuthFormHandle,
  AuthFormProps,
  AuthMode,
  AuthStep,
  LoginDraft,
} from '@components/src/auth/AuthForm'
export { AuthModal } from '@components/src/auth/AuthModal'
export type { AuthModalProps } from '@components/src/auth/AuthModal'
export { InvitationEmailForm, InvitationCodeForm, InvitationProfileForm, invitationEmailSchema } from '@components/src/auth/InvitationForms'
export { CfxPayloadForm } from '@components/src/auth/CfxPayloadForm'
export { RegistrationEmailForm } from '@components/src/auth/RegistrationEmailForm'
export { IdentityLinksPanel } from '@components/src/auth/IdentityLinksPanel'
export type { InvitationProfileValues } from '@components/src/auth/InvitationForms'
export type { InvitationFormErrorKind, InvitationFormErrors, InvitationFormHandle } from '@components/src/auth/invitationFeedback'
export { JoinReviewDialog } from '@components/src/join/JoinReviewDialog'
export { CompleteJoinApplicationModal } from '@components/src/join/CompleteJoinApplicationModal'
export type { CompleteJoinApplicationModalHandle, CompleteJoinApplicationModalProps } from '@components/src/join/CompleteJoinApplicationModal'
export type { JoinApplicationDraft, JoinApplicationType, NewJoinApplicationDraft, ExperiencedJoinApplicationDraft } from '@components/src/join/applicationSchemas'
export { newJoinApplicationSchema, experiencedJoinApplicationSchema } from '@components/src/join/applicationSchemas'
export { joinApplicationFields, joinApplicationCommitments, joinApplicationSteps, applicantCategoryOptions, departmentOptions, discoveryChannelOptions } from '@components/src/join/applicationFields'

export { TiptapEditor } from './tiptap/TiptapEditor'
export { TiptapViewer } from './tiptap/TiptapViewer'
export { parseTiptapContent, serializeTiptapMarkdown } from './tiptap/conversion'
export { createMarkdownExtensions, parseMarkdownContent, serializeMarkdownContent, MarkdownEmojiPicker } from './tiptap/markdown'
export { tiptapContentClassName } from './tiptap/content-styles'
export type { MarkdownExtensionOptions, MarkdownEmojiAnchor, MarkdownEmojiPickerProps } from './tiptap/markdown'
export type { TiptapInput, TiptapIssueCode, TiptapIssue, TiptapResult, TiptapContentPolicy, TiptapMentionItem, TiptapUploadedImage, TiptapEditorHandle, TiptapEditorProps, TiptapViewerProps } from './tiptap/types'

export { useMarkdownPreset, useTiptapPreset } from './tiptap/presets'
export { useTiptapEditor } from './tiptap/useTiptapEditor'
export type { TiptapPlaceholder, MarkdownPresetOptions, TiptapPresetOptions, MarkdownPreset, FullTiptapPreset, TiptapPreset, TiptapEditorSessionOptions, TiptapServiceCallbacks, UseTiptapEditorOptions, UseTiptapEditorResult } from './tiptap/types'
