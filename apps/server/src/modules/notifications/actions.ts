import { NotificationError } from './errors.js'

/**
 * 静态 Action registry。
 *
 * N1 只注册已存在的导航目标；没有真实业务 adapter 时，业务命令一律返回
 * `unsupported`，不登记成 enabled，也不创建假的成功 handler。
 * 执行入口**不在** HTTP Contract 中：没有真实业务模块就没有 operation。
 *
 * 服务端从存储的结构化 descriptor 取目标，客户端不能提交 userId/resourceId/
 * API/参数来替换目标；Web 只按 kind 展示并调用共享 Client。
 */

export const NAVIGATION_TARGETS = {
  'account.settings': '/account/profile',
  'community.home': '/communities/rifling-911',
  'community.application-result': '/join/result',
} as const

export type NavigationTargetKey = keyof typeof NAVIGATION_TARGETS

export type StoredActionDescriptor =
  | {
      kind: 'navigate'
      actionId: string
      targetKey: NavigationTargetKey
      emphasis: 'primary' | 'secondary'
    }
  | {
      kind: 'command'
      actionId: string
      actionType: string
      commandVersion: number
      emphasis: 'primary' | 'secondary'
    }

export type ResolvedAction = {
  actionId: string
  kind: 'navigate' | 'command'
  label: string
  emphasis: 'primary' | 'secondary'
  enabled: boolean
  unavailableReason: 'unsupported' | 'expired' | 'forbidden' | 'state_changed' | null
  navigationTarget: { kind: 'internal'; path: string } | null
}

const NAVIGATION_LABELS: Record<NavigationTargetKey, string> = {
  'account.settings': '前往账号设置',
  'community.home': '查看社区主页',
  'community.application-result': '查看申请结果',
}

export const MAX_ACTIONS_PER_CONTENT = 4

export function isNavigationTargetKey(value: string): value is NavigationTargetKey {
  return Object.hasOwn(NAVIGATION_TARGETS, value)
}

/**
 * 启动时校验 registry 无重复、无缺口。缺实现不算错误，但必须可被发现。
 */
export function assertActionRegistry(): void {
  const labels = new Set<string>()
  for (const key of Object.keys(NAVIGATION_TARGETS) as NavigationTargetKey[]) {
    const path = NAVIGATION_TARGETS[key]
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`导航目标 ${key} 未解析为站内绝对路径。`)
    }
    const label = NAVIGATION_LABELS[key]
    if (label === undefined) throw new Error(`导航目标 ${key} 缺少文案。`)
    if (labels.has(label)) throw new Error(`导航目标文案重复：${label}`)
    labels.add(label)
  }
}

export function parseStoredActions(raw: string): StoredActionDescriptor[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new NotificationError('CONTENT_UNSAFE')
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ACTIONS_PER_CONTENT) {
    throw new NotificationError('CONTENT_UNSAFE')
  }
  const seen = new Set<string>()
  const actions: StoredActionDescriptor[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) throw new NotificationError('CONTENT_UNSAFE')
    const candidate = entry as Record<string, unknown>
    const actionId = candidate.actionId
    if (typeof actionId !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(actionId) || seen.has(actionId)) {
      throw new NotificationError('CONTENT_UNSAFE')
    }
    seen.add(actionId)
    const emphasis = candidate.emphasis === 'primary' ? 'primary' : 'secondary'
    if (candidate.kind === 'navigate') {
      const targetKey = candidate.targetKey
      if (typeof targetKey !== 'string' || !isNavigationTargetKey(targetKey)) {
        throw new NotificationError('CONTENT_UNSAFE')
      }
      actions.push({ kind: 'navigate', actionId, targetKey, emphasis })
      continue
    }
    // 业务命令：N1 没有真实 adapter，登记即视为协议保留，不产生可执行入口。
    if (candidate.kind === 'command') {
      const actionType = candidate.actionType
      const commandVersion = candidate.commandVersion
      if (typeof actionType !== 'string' || !/^[a-z0-9.]{1,64}$/.test(actionType) ||
        commandVersion !== 1) {
        throw new NotificationError('CONTENT_UNSAFE')
      }
      actions.push({ kind: 'command', actionId, actionType, commandVersion, emphasis })
      continue
    }
    throw new NotificationError('CONTENT_UNSAFE')
  }
  return actions
}

/**
 * 解析当前状态下的 Action 展示结果。
 *
 * 过期或不可见的通知不再提供导航命令；业务命令永远 unsupported，
 * 因为 N1 没有真实业务 adapter。
 */
export function resolveActions(
  stored: StoredActionDescriptor[],
  context: { expired: boolean; visible: boolean },
): { actions: ResolvedAction[]; available: boolean } {
  if (!context.visible) return { actions: [], available: false }
  const actions = stored.map<ResolvedAction>(descriptor => {
    if (descriptor.kind === 'command') {
      return {
        actionId: descriptor.actionId,
        kind: 'command',
        label: '该操作尚未接入',
        emphasis: descriptor.emphasis,
        enabled: false,
        unavailableReason: 'unsupported',
        navigationTarget: null,
      }
    }
    const path = NAVIGATION_TARGETS[descriptor.targetKey]
    if (context.expired) {
      return {
        actionId: descriptor.actionId,
        kind: 'navigate',
        label: NAVIGATION_LABELS[descriptor.targetKey],
        emphasis: descriptor.emphasis,
        enabled: false,
        unavailableReason: 'expired',
        navigationTarget: null,
      }
    }
    return {
      actionId: descriptor.actionId,
      kind: 'navigate',
      label: NAVIGATION_LABELS[descriptor.targetKey],
      emphasis: descriptor.emphasis,
      enabled: true,
      unavailableReason: null,
      navigationTarget: { kind: 'internal', path },
    }
  })
  return { actions, available: actions.length > 0 }
}
