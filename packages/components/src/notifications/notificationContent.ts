/**
 * `notification-html-v1` 的**只读**呈现校验层。
 *
 * 这里消费的是服务端已按同一策略规范化、并在读取时重新校验过的安全 HTML。
 * 即便如此，本模块仍然**独立再校验一次**：共享 UI 不能假设上游永远正确，也不允许把
 * API 返回的字符串交给 `dangerouslySetInnerHTML`。
 *
 * 输出是固定的 React 元素与转义文本节点（见 `NotificationBody.tsx`）：
 *
 * - 没有 `dangerouslySetInnerHTML`、没有 `innerHTML`、没有 `eval` / `new Function`；
 * - 不编译、不运行 MDX，不注册任何组件或表达式；
 * - 解析使用 `DOMParser` 的 `text/html` 文档，它不绑定浏览上下文，因此不执行脚本、
 *   不加载子资源；解析结果还要再过一遍元素/属性/URL 白名单才允许渲染；
 * - 元素白名单、上下文规则与 URL 政策与服务端
 *   `apps/server/src/modules/notifications/html/` 保持一致，任一侧调整都必须同步。
 *
 * 校验**失败即整体不可用**（fail closed），不做「部分渲染」：服务端产出的是规范化后的
 * 安全 HTML，任何不在白名单里的元素或属性都说明这份内容不是由当前策略产生的。
 * 调用方改用 `contentFallbackText` 并展示「正文格式暂不可用」，绝不展示原始 HTML。
 * 纯文本回退完整保留了可读内容，因此失败关闭不丢正文。
 *
 * **预算口径必须与服务端同构**（见 `ParseBudget` 与 `tests/notifications/contentPolicyParity.test.ts`）：
 * 列数按行统计、行数按表统计。整份正文累计计数会让设计 4.2 允许的合法表格
 * （例如 3×3，共 9 个单元格）在客户端被判超限，从而整份正文降级成纯文本 ——
 * 那是「服务端接受、客户端永远渲染不了」的假失败，不是安全策略。
 */

export const NOTIFICATION_CONTENT_POLICY_VERSION = 'notification-html-v1'
export const NOTIFICATION_CONTENT_SCHEMA_VERSION = 1

/** 元素白名单：与服务端 `sanitize.ts` 的 `ALLOWED` 完全一致。 */
const FLOW_TAGS = ['p', 'br', 'h2', 'h3', 'strong', 'em', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'a'] as const
const TABLE_TAGS = ['table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td'] as const

export type SafeContentTag = (typeof FLOW_TAGS)[number] | (typeof TABLE_TAGS)[number]

const ALLOWED_TAGS = new Set<string>([...FLOW_TAGS, ...TABLE_TAGS])

/**
 * 允许的子元素上下文：与服务端 `sanitize.ts` 的 `CONTEXT` 一致。
 * 上下文不合法时元素被**展开**（保留子节点），而不是丢弃正文。
 */
const ALLOWED_CHILDREN: Record<string, Set<string>> = {
  '#root': new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'table']),
  p: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
  h2: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
  h3: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
  li: new Set(['br', 'strong', 'em', 's', 'code', 'a', 'ul', 'ol']),
  blockquote: new Set(['p', 'br', 'strong', 'em', 's', 'code', 'a', 'ul', 'ol']),
  pre: new Set(['br', 'code']),
  ul: new Set(['li']),
  ol: new Set(['li']),
  a: new Set(['br', 'strong', 'em', 's', 'code']),
  strong: new Set(['br', 'em', 's', 'code', 'a']),
  em: new Set(['br', 'strong', 's', 'code', 'a']),
  s: new Set(['br', 'strong', 'em', 'code', 'a']),
  code: new Set(['br']),
  caption: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
  table: new Set(['caption', 'thead', 'tbody', 'tr']),
  thead: new Set(['tr']),
  tbody: new Set(['tr']),
  tr: new Set(['th', 'td']),
  th: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
  td: new Set(['br', 'strong', 'em', 's', 'code', 'a']),
}

const VOID_TAGS = new Set(['br', 'hr'])

/** 与服务端一致：正文不带任何属性，只有 `a[href]` 与 `th[scope]` 例外。 */
const DANGEROUS_ATTRIBUTE_NAMES = new Set([
  'style', 'srcdoc', 'src', 'srcset', 'formaction', 'action', 'background', 'poster', 'ping',
  'http-equiv', 'content', 'sandbox', 'allow', 'allowfullscreen', 'xlink:href', 'autofocus',
])

/** 现有站内只读页面：与服务端 `policy.ts` 的 `INTERNAL_READ_ONLY_PATHS` 一致。 */
const INTERNAL_READ_ONLY_PATHS = new Set([
  '/',
  '/communities/rifling-911',
  '/communities/caep',
  '/join/rifling-911',
  '/join/result',
])

/**
 * 运营批准的精确外部目标。N1 为空，与外部 HTTPS 一律拒绝的政策保持一致：
 * 一旦这里出现条目，渲染侧必须同时给出「外部站点」说明与 `rel="noopener noreferrer"`。
 */
const APPROVED_EXTERNAL_TARGETS: readonly { host: string; port: number | null; path: string }[] = []

const MAX_TABLE_ROWS = 20
const MAX_TABLE_COLUMNS = 6
const MAX_NODES = 1000
const MAX_DEPTH = 16

/**
 * 解析预算。
 *
 * 表格口径与服务端 `sanitize.ts::sanitizeTable` **逐条对应**，不能改成整份正文累计：
 *
 * | 预算 | 统计范围 | 服务端位置 |
 * | --- | --- | --- |
 * | `tableRows` | 单个 `<table>` 内的 `<tr>` 数 | `collectRows(table).length > MAX_TABLE_ROWS` |
 * | `rowColumns` | 单个 `<tr>` 内的 `<th>`/`<td>` 数 | `cells.length > MAX_TABLE_COLUMNS` |
 * | `tableColumns` | 该表的最大行宽，用于拒收空表 | `columns === 0` |
 *
 * 表格不能嵌套（`tr` 的允许上下文只有 `th`/`td`），因此进入 `<table>` 时归零即为按表计数。
 */
interface ParseBudget {
  nodes: number
  /** 当前 `<table>` 内已见行数；进入 `<table>` 时归零。 */
  tableRows: number
  /** 当前 `<tr>` 内已见单元格数；进入 `<tr>` 时归零。 */
  rowColumns: number
  /** 当前 `<table>` 内见过的最大行宽。 */
  tableColumns: number
}

export interface SafeTextNode {
  type: 'text'
  value: string
}

export interface SafeElementNode {
  type: 'element'
  tag: SafeContentTag
  children: SafeContentNode[]
  /** 仅 `a` 具备，且只可能是已通过 URL 政策的站内只读路径。 */
  href?: string
  /** 仅 `th` 具备，且只可能是 `row` 或 `col`。 */
  scope?: 'row' | 'col'
}

export type SafeContentNode = SafeTextNode | SafeElementNode

/** 校验前的原始内容形状；与 Contract 的 `NotificationContent` 结构一致，由 `apps/web` 直接传入。 */
export interface NotificationContentInput {
  format: string
  schemaVersion: number
  policyVersion: string
  html: string
  text: string
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlCodePoint(char.codePointAt(0) ?? 0)) return true
  }
  return false
}

function stripFragment(value: string): string | null {
  const index = value.indexOf('#')
  if (index === -1) return value
  return index === value.length - 1 ? value.slice(0, -1) : null
}

function normalizePath(value: string): string | null {
  if (value.includes('//')) return null
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return null
    if (/%2e/i.test(segment)) return null
  }
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}

function classifyHref(rawHref: string): string | null {
  const href = rawHref.trim()
  if (href.length === 0) return null
  if (containsControlCharacter(href)) return null
  // trim 之后仍有空白，说明作者用了 `java\tscript:` 之类的拆分技巧。
  if (/\s/.test(href)) return null
  if (href.startsWith('//')) return null

  if (href.startsWith('/')) {
    const withoutFragment = stripFragment(href)
    if (withoutFragment === null) return null
    if (withoutFragment.includes('?')) return null
    if (withoutFragment.startsWith('//')) return null
    const normalized = normalizePath(withoutFragment)
    if (normalized === null) return null
    return INTERNAL_READ_ONLY_PATHS.has(normalized) ? normalized : null
  }

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (url.hash || url.search) return null
  const approved = APPROVED_EXTERNAL_TARGETS.some(target =>
    target.host === url.hostname
    && target.port === (url.port === '' ? null : Number(url.port))
    && target.path === url.pathname)
  return approved ? url.href : null
}

/**
 * 把一份已规范化、`notification-html-v1` 的正文解析成可安全渲染的固定节点树。
 *
 * 返回 `null` 表示**不可用**，调用方必须改用纯文本回退。任何一项校验失败都以 `null`
 * 结束，不做「部分渲染」：半截正文会让「格式不可用」这条信息失效。
 */
export function parseNotificationContent(content: NotificationContentInput | null | undefined): SafeContentNode[] | null {
  if (!content) return null
  if (content.format !== 'html') return null
  if (content.schemaVersion !== NOTIFICATION_CONTENT_SCHEMA_VERSION) return null
  if (content.policyVersion !== NOTIFICATION_CONTENT_POLICY_VERSION) return null
  if (typeof content.html !== 'string' || content.html.length === 0) return null

  if (typeof DOMParser === 'undefined') return null
  let document: Document
  try {
    // `text/html` 文档没有浏览上下文：不执行脚本、不加载子资源、不解析 `iframe` 内容。
    document = new DOMParser().parseFromString(content.html, 'text/html')
  } catch {
    return null
  }
  // `template` 的内容不会出现在 `body` 的子节点里，会被静默跳过而不是被拒绝；
  // 它不在白名单中，出现即视为不可用。
  if (document.querySelector('template') !== null) return null

  const budget: ParseBudget = { nodes: 0, tableRows: 0, rowColumns: 0, tableColumns: 0 }
  try {
    const nodes = convertChildren(document.body, '#root', 0, budget)
    // 空正文不渲染：调用方拿不到任何可读内容，应走回退。
    return nodes.length > 0 ? nodes : null
  } catch {
    return null
  }
}

function convertChildren(
  parent: Element,
  parentTag: string,
  depth: number,
  budget: ParseBudget,
): SafeContentNode[] {
  const output: SafeContentNode[] = []
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */ || child.nodeType === 4 /* CDATA_SECTION_NODE */) {
      const value = child.nodeValue ?? ''
      if (value.length === 0) continue
      budget.nodes += 1
      if (budget.nodes > MAX_NODES) throw new Error('notification-html-v1 node limit exceeded')
      output.push({ type: 'text', value })
      continue
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue

    const element = child as Element
    const tag = element.tagName.toLowerCase()
    budget.nodes += 1
    if (budget.nodes > MAX_NODES) throw new Error('notification-html-v1 node limit exceeded')
    if (depth + 1 > MAX_DEPTH) throw new Error('notification-html-v1 depth limit exceeded')

    const attributes = collectAttributes(element, tag)
    const allowed = ALLOWED_CHILDREN[parentTag]
    const inContext = allowed !== undefined && allowed.has(tag)

    // 失败关闭：不在白名单、不在允许上下文、或携带非白名单属性 → 整份正文不可用。
    if (!ALLOWED_TAGS.has(tag) || attributes === null || !inContext) {
      throw new Error(`notification-html-v1 rejected element <${tag}>`)
    }

    const node: SafeElementNode = { type: 'element', tag: tag as SafeContentTag, children: [] }
    if (tag === 'a') {
      const href = element.getAttribute('href')
      const safeHref = href === null ? null : classifyHref(href)
      if (safeHref === null) throw new Error('notification-html-v1 rejected href')
      node.href = safeHref
    }
    if (tag === 'th') {
      const scope = element.getAttribute('scope')
      if (scope !== null && scope !== 'row' && scope !== 'col') {
        throw new Error('notification-html-v1 rejected th scope')
      }
      if (scope !== null) node.scope = scope
    }
    // 表格预算：行数按表、列数按行，与服务端 `sanitizeTable` 同构。
    if (tag === 'table') {
      budget.tableRows = 0
      budget.tableColumns = 0
    }
    if (tag === 'tr') {
      budget.rowColumns = 0
      budget.tableRows += 1
      if (budget.tableRows > MAX_TABLE_ROWS) throw new Error('notification-html-v1 table row limit exceeded')
    }
    if (tag === 'th' || tag === 'td') {
      budget.rowColumns += 1
      if (budget.rowColumns > MAX_TABLE_COLUMNS) throw new Error('notification-html-v1 table column limit exceeded')
      budget.tableColumns = Math.max(budget.tableColumns, budget.rowColumns)
    }

    if (!VOID_TAGS.has(tag)) {
      node.children = convertChildren(element, tag, depth + 1, budget)
    }
    // 空表（没有行、或所有行都没有单元格）与服务端 `columns === 0` 一样拒收。
    if (tag === 'table' && (budget.tableRows === 0 || budget.tableColumns === 0)) {
      throw new Error('notification-html-v1 rejected empty table')
    }
    output.push(node)
    continue
  }
  return output
}

/**
 * 读取元素上允许存在的属性。
 *
 * 返回 `null` 表示出现了非白名单属性 —— 这是**整份正文不可用**的信号，因为正文不应
 * 携带任何属性，出现未知属性说明内容不是由当前策略产生的。
 */
function collectAttributes(element: Element, tag: string): Record<string, string> | null {
  const result: Record<string, string> = {}
  const permitted = tag === 'a' ? new Set(['href']) : tag === 'th' ? new Set(['scope']) : new Set<string>()
  for (const name of element.getAttributeNames()) {
    const lower = name.toLowerCase()
    if (lower.startsWith('on')) return null
    if (DANGEROUS_ATTRIBUTE_NAMES.has(lower)) return null
    if (!permitted.has(lower)) return null
    result[lower] = element.getAttribute(name) ?? ''
  }
  return result
}
