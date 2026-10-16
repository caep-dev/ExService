// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeNotificationHtml } from '@server/src/modules/notifications/html/sanitize'
import {
  NOTIFICATION_CONTENT_POLICY_VERSION, NOTIFICATION_CONTENT_SCHEMA_VERSION,
  parseNotificationContent, type SafeContentNode,
} from '@components/src/notifications/notificationContent'

/**
 * 服务端 sanitizer 与客户端只读校验层的**策略同构**交叉验证。
 *
 * 背景：`notificationContent.ts` 曾经按「整份正文累计」统计表格行/列，而服务端
 * `sanitize.ts::sanitizeTable` 是列数按行、行数按表。结果是设计 4.2 允许的合法表格
 * （最多 6 列 × 20 行）只要单元格数超过 6，前端就一律降级成纯文本 ——
 * 属于「服务端接受、客户端永远渲染不了」的假失败，且让「两侧策略一致」的说法失效。
 *
 * 这里**用真实的服务端 sanitizer 输出喂给真实的客户端 parser**，不复制任一侧的
 * 白名单或常量，任一侧单独改动预算都会让这条用例失败。
 */

/** 先过服务端规范化，再过客户端只读校验；返回两侧的真实判定。 */
function roundTrip(rawHtml: string): {
  serverAccepted: boolean
  clientRenderable: boolean
  tree: SafeContentNode[] | null
} {
  const sanitized = sanitizeNotificationHtml(rawHtml)
  if (!sanitized.ok) return { serverAccepted: false, clientRenderable: false, tree: null }
  const tree = parseNotificationContent({
    format: 'html',
    schemaVersion: NOTIFICATION_CONTENT_SCHEMA_VERSION,
    policyVersion: NOTIFICATION_CONTENT_POLICY_VERSION,
    html: sanitized.result.html,
    text: sanitized.result.text,
  })
  return { serverAccepted: true, clientRenderable: tree !== null, tree }
}

function table(rows: number, columns: number, options: { caption?: boolean } = {}): string {
  const body: string[] = []
  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = []
    for (let column = 0; column < columns; column += 1) cells.push(`<td>r${row}c${column}</td>`)
    body.push(`<tr>${cells.join('')}</tr>`)
  }
  // 服务端要求表格带 caption 或紧邻的语义标题，否则整份正文就是 CONTENT_UNSAFE。
  const caption = options.caption === false ? '' : '<caption>表</caption>'
  return `<h2>标题</h2><table>${caption}${body.join('')}</table>`
}

describe('服务端接受的正文，客户端必须能渲染', () => {
  it('本人申请结果链接只允许固定页面，不接受邮箱或凭证 query', () => {
    expect(roundTrip('<p><a href="/join/result">查看申请结果</a></p>')).toMatchObject({serverAccepted:true,clientRenderable:true})
    expect(roundTrip('<p><a href="/join/result?email=other@example.com">查看</a></p>')).toMatchObject({serverAccepted:false,clientRenderable:false})
  })
  // 5 个形状来自独立评审的失败探针；20×6 是设计 4.2 的上限（120 个单元格）。
  const legalTables: readonly [number, number][] = [
    [2, 3], [3, 3], [4, 2], [2, 6], [7, 2], [20, 6], [1, 1],
  ]

  it.each(legalTables)('单个 %i 行 × %i 列表格', (rows, columns) => {
    const result = roundTrip(table(rows, columns))
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
    // C1：只断言「能渲染」不够 —— 若将来改成静默截断，这条仍会绿。
    // 所以上界那一档必须数出真正的行数和行宽，且正文里没有回退提示。
    expect(countTags(result.tree!, 'tr')).toBe(rows)
    const rowWidths = collectRows(result.tree!).map(row => countTags(row, 'td') + countTags(row, 'th'))
    expect(Math.max(...rowWidths)).toBe(columns)
    expect(rowWidths.every(width => width === columns)).toBe(true)
  })

  it.each([10, 11, 20] as const)('同正文内两张表，每张 %i 行（行数按表，不累计）', rowsEach => {
    const result = roundTrip(table(rowsEach, 2) + table(rowsEach, 2))
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
    expect(collectTags(result.tree!).filter(tag => tag === 'table')).toHaveLength(2)
  })

  it('两张表各 6 列（列数按行，不累计）', () => {
    const result = roundTrip(table(3, 6) + table(3, 6))
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
  })

  it('常见富文本正文（标题、列表、链接、引用、代码块、表格）', () => {
    const result = roundTrip('<h2>社区公告</h2><p>本周维护窗口已确定，详见 '
      + '<a href="/communities/rifling-911">社区主页</a>。</p>'
      + '<ul><li>窗口：周六 02:00</li><li>影响：登录与文档</li></ul>'
      + '<blockquote><p>引用 <strong>说明</strong></p></blockquote>'
      + '<pre><code>npm run build</code></pre>'
      + '<table><caption>影响范围</caption><thead><tr><th scope="col">模块</th>'
      + '<th scope="col">影响</th></tr></thead><tbody><tr><th scope="row">登录</th>'
      + '<td>短暂不可用</td></tr></tbody></table>')
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
  })
})

describe('服务端产出 → 客户端渲染（含被服务端改写过的正文）', () => {
  it('渲染服务端展开装饰标签之后的产物', () => {
    // C3：服务端会把不在白名单里的普通装饰标签**展开**为安全子节点再序列化。
    // 客户端拿到的是改写后的字节，这条才是真实的「服务端产出 → 客户端渲染」路径。
    // 注意 `<b>`/`<i>` 属于服务端的「出现即失败」清单，只有 `span`/`div` 这类才会被展开。
    const result = roundTrip('<h2>标题</h2><div><p>正文里有 <span>包裹</span> 与装饰。</p></div>')
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
    // 被展开的标签不会出现在产物里；正文仍在。
    expect(collectTags(result.tree!)).not.toContain('span')
    expect(collectText(result.tree!).join('')).toContain('包裹')
  })

  it('记录节点预算的分叉（未纳入自动对齐）', () => {
    // C2：客户端按 **DOM 文本节点**计数，服务端按**合并后的文本 token**计数，
    // 两侧的 MAX_NODES(1000) / MAX_DEPTH(16) 因此不同构。这里断言「被 <br> 隔开的
    // 大量短文本」两侧都接受，说明当前留有充分余量；但这两个上限本身没有被自动对齐，
    // 任一侧单独调整它们都不会让本文件的用例失败 —— 仍需人工同步。
    const body = `<p>${Array.from({ length: 60 }, (_, index) => `字${index}<br>`).join('')}</p>`
    const result = roundTrip(body)
    expect(result.serverAccepted).toBe(true)
    expect(result.clientRenderable).toBe(true)
  })
})

describe('两侧的超限判定一致（防御纵深，不是服务端产出路径）', () => {
  // C3：下面三条例的是**没有经过 sanitizer 的原始 HTML**——真实链路里客户端只会拿到
  // 服务端已规范化的产物，这些输入根本到不了渲染层。保留它们的价值是「任一侧被绕过或
  // 被单独调用时也要 fail closed」，不代表「服务端接受 ⇒ 客户端可渲染」的反方向。
  it('21 行：服务端拒绝，客户端也拒绝', () => {
    const result = roundTrip(table(21, 1))
    expect(result.serverAccepted).toBe(false)
    expect(parseNotificationContent({
      format: 'html', schemaVersion: NOTIFICATION_CONTENT_SCHEMA_VERSION,
      policyVersion: NOTIFICATION_CONTENT_POLICY_VERSION,
      html: table(21, 1), text: 'x',
    })).toBeNull()
  })

  it('单行 7 列：服务端拒绝，客户端也拒绝', () => {
    const raw = table(1, 7)
    expect(roundTrip(raw).serverAccepted).toBe(false)
    expect(parseNotificationContent({
      format: 'html', schemaVersion: NOTIFICATION_CONTENT_SCHEMA_VERSION,
      policyVersion: NOTIFICATION_CONTENT_POLICY_VERSION, html: raw, text: 'x',
    })).toBeNull()
  })

  it('空表（只有 caption）：服务端拒绝，客户端也拒绝', () => {
    const raw = '<h2>标题</h2><table><caption>表</caption></table>'
    expect(roundTrip(raw).serverAccepted).toBe(false)
    expect(parseNotificationContent({
      format: 'html', schemaVersion: NOTIFICATION_CONTENT_SCHEMA_VERSION,
      policyVersion: NOTIFICATION_CONTENT_POLICY_VERSION, html: raw, text: 'x',
    })).toBeNull()
  })
})

function collectTags(nodes: SafeContentNode[]): string[] {
  const output: string[] = []
  for (const node of nodes) {
    if (node.type === 'text') continue
    output.push(node.tag)
    output.push(...collectTags(node.children))
  }
  return output
}

function countTags(nodes: SafeContentNode[], tag: string): number {
  return collectTags(nodes).filter(found => found === tag).length
}

/** 收集所有 `<tr>` 子树，用于逐行核对列数。 */
function collectRows(nodes: SafeContentNode[]): SafeContentNode[][] {
  const output: SafeContentNode[][] = []
  for (const node of nodes) {
    if (node.type === 'text') continue
    if (node.tag === 'tr') output.push(node.children)
    else output.push(...collectRows(node.children))
  }
  return output
}

function collectText(nodes: SafeContentNode[]): string[] {
  const output: string[] = []
  for (const node of nodes) {
    if (node.type === 'text') output.push(node.value)
    else output.push(...collectText(node.children))
  }
  return output
}
