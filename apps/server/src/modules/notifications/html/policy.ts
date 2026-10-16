/**
 * `notification-html-v1` 的 URL 策略。
 *
 * 正文链接只允许：
 * 1. 现有站内只读页面（精确路径白名单，无 query、无 fragment、无凭据）；
 * 2. 运营批准的精确 HTTPS host/port/path —— N1 没有任何已批准外部目标，
 *    因此 `APPROVED_EXTERNAL_TARGETS` 为空，所有外部地址一律拒绝。
 *
 * 身份、退出、注册、审核和设置类地址不是只读页面，正文不得指向它们：
 * 正文链接只负责导航，业务改变必须走结构化 Action。
 */

export const POLICY_VERSION = 'notification-html-v1'

/** 现有站内只读页面：这些内容页不读私人数据、不改变业务状态。 */
export const INTERNAL_READ_ONLY_PATHS = new Set([
  '/',
  '/communities/rifling-911',
  '/communities/caep',
  '/join/rifling-911',
  '/join/result',
])

/**
 * 运营批准的精确外部目标（scheme + host + port + 精确 path）。
 * N1 为空：没有第三方集成、没有已审查的外部目标，因此不启用外链。
 */
export const APPROVED_EXTERNAL_TARGETS: ReadonlyArray<{
  host: string
  port: number | null
  path: string
}> = []

export type UrlDecision =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'rejected'; reason: string }

/** C0 与 C1 控制字符：URL 与正文都不得包含它们。 */
export function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlCodePoint(char.codePointAt(0)!)) return true
  }
  return false
}

export function classifyHref(rawHref: string): UrlDecision {
  const href = rawHref.trim()
  if (href.length === 0) return { kind: 'rejected', reason: 'empty' }
  if (containsControlCharacter(href)) return { kind: 'rejected', reason: 'control-character' }
  // trim 之后仍存在空白，说明作者用了拆分技巧（如 `java\tscript:` 或 `http://a b`）。
  if (/\s/.test(href)) return { kind: 'rejected', reason: 'whitespace' }

  // 协议相对地址 `//host/path` 会继承页面协议，禁止。
  if (href.startsWith('//')) return { kind: 'rejected', reason: 'protocol-relative' }

  if (href.startsWith('/')) {
    const withoutFragment = stripFragment(href)
    if (withoutFragment === null) return { kind: 'rejected', reason: 'fragment' }
    if (withoutFragment.includes('?')) return { kind: 'rejected', reason: 'query' }
    if (withoutFragment.startsWith('//')) return { kind: 'rejected', reason: 'protocol-relative' }
    const normalized = normalizePath(withoutFragment)
    if (normalized === null) return { kind: 'rejected', reason: 'path-traversal' }
    if (!INTERNAL_READ_ONLY_PATHS.has(normalized)) return { kind: 'rejected', reason: 'not-allowlisted' }
    return { kind: 'internal', path: normalized }
  }

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: 'rejected', reason: 'unparsable' }
  }
  if (url.protocol !== 'https:') return { kind: 'rejected', reason: 'not-https' }
  if (url.username || url.password) return { kind: 'rejected', reason: 'credentials' }
  if (url.hash) return { kind: 'rejected', reason: 'fragment' }
  if (url.search) return { kind: 'rejected', reason: 'query' }
  const approved = APPROVED_EXTERNAL_TARGETS.some(target =>
    target.host === url.hostname &&
    target.port === (url.port === '' ? null : Number(url.port)) &&
    target.path === url.pathname)
  if (!approved) return { kind: 'rejected', reason: 'not-allowlisted' }
  return { kind: 'external', url: url.href }
}

function stripFragment(value: string): string | null {
  const index = value.indexOf('#')
  if (index === -1) return value
  // 只有空 fragment（`/path#`）可以接受，其余一律拒绝。
  return index === value.length - 1 ? value.slice(0, -1) : null
}

/** 只接受已白名单化的精确路径；`..`、`.`、`%2e` 与双斜杠都拒绝。 */
function normalizePath(value: string): string | null {
  if (value.includes('//')) return null
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return null
    if (/%2e/i.test(segment)) return null
  }
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}
