/**
 * 通知 catalog：封闭的事件、scope、类别与必要性。
 *
 * 来源 label、必要类别和 Action 都取自这份注册项，正文不能伪造「安全系统」
 * 或授权。未知 eventType/version 一律停止投影并隔离，不用自由 JSON 补字段。
 */

export const NOTIFICATION_SCOPES = ['community', 'personal'] as const
export type NotificationScope = typeof NOTIFICATION_SCOPES[number]

export const NOTIFICATION_CATEGORIES = ['announcement', 'personal_update', 'service_notice'] as const
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]

export type NotificationNecessity = 'optional' | 'necessary'

export const NOTIFICATION_EVENT_TYPES = [
  'community.announcement.published',
  'community.announcement.withdrawn',
  'personal.notice.issued',
  'join.application.approved',
  'join.application.rejected',
] as const
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number]

export const EVENT_VERSION = 1

interface CatalogEntry {
  readonly eventType: NotificationEventType
  readonly version: number
  readonly scope: NotificationScope
  readonly category: NotificationCategory
  readonly necessity: NotificationNecessity
  /** 是否创建新的 receipt（撤回只改变内容生命周期，不再建收件）。 */
  readonly createsReceipt: boolean
  readonly sourceLabel: string
  readonly audiencePolicy?: 'single_existing_user'
}

const CATALOG: Record<NotificationEventType, CatalogEntry> = {
  'join.application.approved': {
    eventType: 'join.application.approved', version: EVENT_VERSION, scope: 'personal', category: 'service_notice',
    necessity: 'necessary', createsReceipt: true, sourceLabel: '社区申请', audiencePolicy: 'single_existing_user',
  },
  'join.application.rejected': {
    eventType: 'join.application.rejected', version: EVENT_VERSION, scope: 'personal', category: 'service_notice',
    necessity: 'necessary', createsReceipt: true, sourceLabel: '社区申请', audiencePolicy: 'single_existing_user',
  },
  'community.announcement.published': {
    eventType: 'community.announcement.published',
    version: EVENT_VERSION,
    scope: 'community',
    category: 'announcement',
    necessity: 'optional',
    createsReceipt: true,
    sourceLabel: '社区公告',
  },
  'community.announcement.withdrawn': {
    eventType: 'community.announcement.withdrawn',
    version: EVENT_VERSION,
    scope: 'community',
    category: 'announcement',
    necessity: 'optional',
    createsReceipt: false,
    sourceLabel: '社区公告',
  },
  'personal.notice.issued': {
    eventType: 'personal.notice.issued',
    version: EVENT_VERSION,
    scope: 'personal',
    category: 'personal_update',
    necessity: 'optional',
    createsReceipt: true,
    sourceLabel: '个人通知',
  },
}

/**
 * 必要通知只能由 catalog 决定：安全或本人访问资格的重要变化。
 * 发布者不能任意把内容标成必要，也不能用必要类别做推广。
 */
const NECESSARY_CATEGORY: NotificationCategory = 'service_notice'

export function catalogEntry(eventType: string, version: number): CatalogEntry | undefined {
  const entry = (CATALOG as Record<string, CatalogEntry | undefined>)[eventType]
  if (entry === undefined || entry.version !== version) return undefined
  return entry
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

export function isNotificationScope(value: string): value is NotificationScope {
  return (NOTIFICATION_SCOPES as readonly string[]).includes(value)
}

/** 必要类别固定且不可关闭；可选类别由本人偏好控制。 */
export function necessityFor(category: NotificationCategory): NotificationNecessity {
  return category === NECESSARY_CATEGORY ? 'necessary' : 'optional'
}

export const NECESSARY_CATEGORIES: readonly NotificationCategory[] = [NECESSARY_CATEGORY]

export const OPTIONAL_CATEGORIES: readonly NotificationCategory[] = ['announcement', 'personal_update']

export const DEFAULT_PREFERENCES: Record<NotificationCategory, boolean> = {
  announcement: true,
  personal_update: true,
  service_notice: true,
}

/** 受众上限：定向最多 100 人，全站建议不超过 10,000 人。 */
export const MAX_DIRECTED_AUDIENCE = 100
export const RECOMMENDED_MAX_AUDIENCE = 10_000

/** 标题与正文长度上限（Unicode 码点）。 */
export const MAX_TITLE_CODE_POINTS = 120
export const MAX_TEXT_CODE_POINTS = 8000
export const MAX_HTML_BYTES = 32 * 1024
export const MAX_SUMMARY_CODE_POINTS = 240
export const MAX_EVENT_BYTES = 64 * 1024

export const CLEAR_TOKEN_TTL_MS = 10 * 60 * 1000
export const READ_THROUGH_TOKEN_TTL_MS = 10 * 60 * 1000
export const CURSOR_TTL_MS = 10 * 60 * 1000
