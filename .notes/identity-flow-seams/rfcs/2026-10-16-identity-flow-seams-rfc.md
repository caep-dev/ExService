# 身份授权、账户接入与关联展示的流程 seam

- 状态：已通过独立架构审查，A/B 已实施并完成独立本地验证
- 日期：2026-10-16
- 范围：架构审查报告的 01–04 项；分两阶段落地
- 依据：`api/openapi.yaml`、`.ai/decisions/auth/01-public-registration-and-community-access.md`、`.ai/databases/decisions/08-account-identity-and-community-membership.md`、`.ai/architectures/server/authentication-lifecycle.md`、`.ai/architectures/web/authentication-flow.md` 及当前源码。报告为 `architecture-review-20261016-012436.html`；本 RFC 的源码位置均相对仓库根目录。

## 决策摘要

本期完成四项优化。Server 让关联授权取消由显式业务流程协调；把可信 Cfx 证明之后的账户接入、唯一性、注册授权快照和原子建链规则集中到一个内部 module。Web 让登录与注册共用第三方登录结果流程，并按 provider 组织关联展示及社区影响。Cfx 授权协议仍由 Cfx module 持有；Cfx 是唯一可用提供方，Google、QQ 保持禁用。所有现有 HTTP operation、请求和响应形状、数据库约束、错误语义保持不变。

这是一项内部责任迁移，不能声称第二提供方已经可接入。未来接入真实提供方时，再依据其 subject、邮箱及验证规则设计 Contract、数据模型和显式 migration。

## 已核实的现状与目标

| 项 | 当前证据 | 本期可检验结果 |
| --- | --- | --- |
| 01 关联取消 | `apps/server/src/modules/identity-links/api/plugin.ts` 通过 `cancelCfxAttempt` 的 `preSerialization` 检查 200/payload，调用 `invalidateCfxAttempt`；`tests/contract/identity-link-cancellation.test.ts` 已测容量、外来浏览器、consumed 竞争。 | 取消 handler 显式调用关联授权流程；删去该 `preSerialization` 协调。原三类 HTTP 回归和同等流程测试继续通过。 |
| 02 第三方账户接入 | `apps/server/src/modules/registration/service.ts` 直接消费 Cfx ticket、查关联、签发会话或持久 grant，并在完成注册时建链；`apps/server/src/modules/identity-links/service.ts` 将 `provider`、SQL 和 `createInside` 固定为 Cfx；`apps/server/src/db/schema.ts` 和 Contract 当前仅允许 Cfx 关联。 | 一个内部账户规则 module 持有 subject 查找、锁后重核、冲突判定、建链及外部 grant 快照恢复；登录、主动关联、完成注册通过它。Cfx adapter 与真实 PostgreSQL 的竞争/重启用例覆盖新 seam。 |
| 03 共享登录结果 | `apps/web/src/auth/AuthFlow.tsx` 和 `apps/web/src/registration/PublicRegistrationFlow.tsx` 各自调用 `signInWithCfx` 并分流三个 `kind`；两处调用 `installBrowserSession`。 | 一个 Web 流程处理三种结果、generation/AbortSignal 失效、会话安装锁定；两个入口只决定呈现与导航。SSO 仍无 Cfx 入口。 |
| 04 provider 展示 | `IdentityLinkService.list()` 以 `links[0]` 填 Cfx；`IdentityLinksExperience` 只找 Cfx 并读取社区影响；`IdentityLinksPanel` 写死三个区块。 | Server 以 provider 匹配当前关联，保持 Contract 指定三项及顺序；Web 按 provider 组织状态和影响，Cfx 可操作、Google/QQ 禁用；owner 代次、写后重读和社区历史语义均有回归验证。 |

业务不变量来自已接受决策：Exre 账户 UUID 独立于第三方关联；每个 `(userId, provider)` 与 `(provider, externalUserId)` 各自唯一；第三方邮箱重复不会自动合并；外部邮箱不成为本站已验证邮箱；解绑不删除密码、申请或社区成员资格。Cfx 在禁用状态不创建协议资源，但已有 Cfx 关联仍可查看、解绑。当前是单实例开发阶段，process-local Cfx attempt 与关联 intent 保留。

## Server 设计：01 显式取消生命周期

取消的唯一业务入口由 `apps/server/src/modules/identity-links/service.ts` 提供，例如 `cancelCfxAttempt(context, attemptId): CfxCancellation`。它先调用 `CfxServices.cancel()`；只有调用成功且返回 `cancelled`、`failed` 或 `expired` 才按 `attemptId + bindingDigest` 失效对应 intent。`consumed` 表示证明已经移交，不失效正在提交的 intent，保留容量直到关联事务结算。Cfx 返回错误时不释放 intent；外来浏览器的 `owned()` 检查先失败，不能释放原 owner 的容量。重复取消以 Cfx 当前终态返回并重复执行安全失效。

`cancelCfxAttempt` 的 HTTP handler 移到 `apps/server/src/modules/identity-links/api/operations.ts` 作为明确协调入口；`apps/server/src/modules/cfx/api/operations.ts` 不再登记同名 handler。`apps/server/src/http/service-handlers.ts` 仍恰好登记一次该 operationId；`apps/server/src/modules/cfx/api/plugin.ts` 的来源、浏览器绑定、请求限制与清理 hook 继续作用于原 operation。`apps/server/src/modules/identity-links/api/plugin.ts` 只保留本模块关联 operation 的 guard，删除跨 operation 的 `preSerialization` 分支。基础 Cfx service 和 API plugin 不依赖关联业务。

关联 intent 仍保留现有 `begin → link / cancel / timeout / unlink / close` 生命周期。`begin` 在用户与会话复核后建立 Cfx attempt；如果建立后发现 intent 已无效，取消刚建立的 attempt 并释放本地意图。`link` 在无 `await` 的窗口一次性消费 ticket，随后持有 `consuming` 预留，事务内锁账号并复核会话、intent 与唯一关系。`unlink` 先锁账号、使该 owner 的旧 intent 无效，再删除当前 Cfx 关系。关闭等待已有写入 settle。容量上限和过期回收维持现值。

## Server 设计：02 可信证明后的账户规则

新内部 module 建议放在 `apps/server/src/modules/external-accounts/`。它提供可信证明后的账户规则 seam，集中如下行为：以 `(provider, subject)` 查询关联；当前关联优先于外部邮箱；锁账号后复核关联行的 `id` 和 subject 再签发本站会话；未关联时检查邮箱重复并给出 `account-exists`；否则产生短期注册授权，持久保存可信外部身份快照；在完成注册事务内以快照建立唯一关联；主动关联时同样执行唯一关系写入并翻译冲突。删除此 module 会使查找、唯一性、账户分支与建链规则重新散布于注册和关联 module，因此它有实际 depth。

这里的 provider 类型本期仍为 `'cfx'`，绝不以宽泛字符串绕过 `auth_identity_links_provider_check`、`auth_registration_grants_kind_check` 或 `api/schemas/identity-links.yaml` 的约束。Cfx adapter 位于 `apps/server/src/modules/external-accounts/cfx-adapter.ts`，仅在服务端调用 `CfxServices.consumeIdentity({ context, identityTicket, expectedAttemptId? })`，并同步转换为内部可信证明。OAEP、manual/redirect、轮询、来源检查仍由 `apps/server/src/modules/cfx/` 负责。浏览器提交的 `identityTicket` 只进入 adapter；浏览器提交的身份 JSON 不进入账户规则。可信证明对象只能由该 adapter 的工厂创建，不能通过 HTTP body 或持久化客户端状态构造。

建议的内部接口是说明性设计，具体命名由实现与类型检查确定：

```ts
type VerifiedExternalIdentity = /* module-private brand */ {
  provider: 'cfx'; subject: string; username: string; providerEmail: string
}

externalAccounts.signInVerified(proof, browserBindingHash)
externalAccounts.createLinkInside(tx, proofOrLockedGrantSnapshot, userId)
externalAccounts.findBySubjectInside(tx, 'cfx', subject)
```

`RegistrationService.signIn` 与 `IdentityLinkService.link` 保留其公共调用职责，但把可信身份之后的账户规则交给该 module；`RegistrationService.complete` 仍拥有邮件 grant 和密码哈希、`active → processing → completed/failed` 生命周期，在同一数据库事务中委托外部快照建链。可以把 grant 的读取、容量、清理和持久快照编解码收进 `apps/server/src/modules/registration/grants.ts`，供注册与账户规则内部复用；不得拆成仅转发原方法的 facade。`apps/server/src/create-services.ts` 按 grant 存储、账户规则、关联意图、注册服务的无环顺序装配。业务核心不调用 HTTP 层。

现有 grant 列用 `kind='cfx'` 与 `external_user_id/external_username/provider_email` 保存快照；重启后完成注册必须从已锁定的服务器端 grant 行恢复，不再次使用已消费的 ticket，不依赖内存证明。外部邮箱仍按当前规则只读预填且不代表本站已验证。保持现有唯一索引和数据库 check、短期过期及完成后五分钟结果重读。竞争时数据库唯一约束是最后防线：同 subject 两份 grant 竞争时输家账号事务回滚，grant 进入失败态；解绑与 sign-in 竞争时锁后校验关联 `id` 防止旧证明登录新关系；被停用账号与撤销会话在锁后拒绝写入。`createLinkInside` 的唯一冲突仍映射 `IDENTITY_LINK_CONFLICT`，不得把数据库异常原文返回浏览器。

这不是提前实现泛化的提供方协议接口。现在只放一个真实 Cfx adapter 和测试用的可控 adapter；将来出现真实第二提供方时，先评审证明来源、subject/邮箱规则、数据库与 Contract 变更，再扩展内部类型和 adapter。

## Web 设计：03 共享第三方登录结果流程

在 `apps/web/src/auth/` 新建第三方登录流程 hook/module，入口提供 `runCfxTicket(ticket, signal)`、`invalidate()` 与可观察的 `busy/outcome`。内部通过生成 Client 调用原 `POST /auth/cfx/sign-in`，只接受当前 generation 且 signal 未中止的结果；依照 Contract 的 `signed-in / registration-required / account-exists` 一次分流。`signed-in` 期间保持两个入口的提交锁，调用现有 `installBrowserSession(token, isCurrent)`，直到旧 token 撤销、当前 owner 核对和存储写入均结算。安装失败保留可重试提示，`stale` 不更新画面、不导航、不安装会话。`registration-required` 将短期 grant 只留在内存，`account-exists` 只建议先用邮箱登录再到设置主动关联，不自动合并。切换流程、取消、卸载或 owner 更换使旧结果失效并清除敏感材料。

`apps/web/src/auth/AuthFlow.tsx` 和 `apps/web/src/registration/PublicRegistrationFlow.tsx` 只把 CfxAuthorization 的 ticket 交给共享流程，分别处理原容器中的表单、资料完善、消息与导航。`CfxAuthorization` 仍独立处理新标签、manual/redirect、可见页串行轮询与取消。共享流程不接管密码登录或 SSO；`ssoRequestId` 路径不挂载 Cfx。安装成功后仍按现有 `onSessionCreated`、Modal reload、独立页 replace 方式完成。若父流程的密码请求或注册步骤改变 generation，共享流程也必须失效；不允许两个独立 generation 互不知晓。

## Web 与 Server 设计：04 按 provider 组织关联

`IdentityLinkService.list()` 先把当前关联按 `provider` 建索引，再按 Contract 要求输出 `cfx, google, qq` 三项。每项用同 provider 的关系匹配，不能用 `links[0]` 或数组位置推断关联。Cfx `available` 来自当前 Cfx 配置；Google、QQ 固定 `available:false, link:null`。如果存储出现不符合当前约束的 provider，拒绝伪装成 Cfx 数据；数据库 check 应在写入时先阻止它。

`IdentityLinksExperience` 把 `IdentityLinksResponse.providers` 投影为按 provider 索引的展示状态，独立记录各项的关联、可用性、写入、社区影响读取状态。当前只有 Cfx 可写；UI 仍展示 Google/QQ 的禁用状态。`packages/components/src/auth/IdentityLinksPanel.tsx` 以 provider 项列表和每项的呈现/动作配置渲染，不调用 API，不把 Cfx 固定为整个 panel 的唯一 props；Cfx 专属授权由 Web adapter 插入。对当前列表，仍是三个固定提供方且顺序与 Contract 一致。社区影响按 `requiredProviders` 与正在操作的 provider 匹配，并仅对已有成员的社区显示提示；读取失败显示“影响未知”及重试，不能当作“无影响”。解绑仍只删除当前关联，不改写申请、审核事实与成员资格；Cfx disabled 仍可确认解绑。

设置模块每个异步请求捕获当前 token owner、generation 和 AbortSignal。换号、退出、卸载立即清空旧关联与影响并拒绝迟到结果。写入 POST 结果可能已提交但响应丢失，必须 GET 本人关联重读后校准界面，不盲目重复同一 ticket；解绑结果不确定时同样以本人关联 GET 判定。写入期间锁定同一 provider 的重复动作；写后重读未完成时不显示未经确认的最终状态。通知沿用 `ExMessage`，持续错误和“重读”入口留在分区内。

## 文件责任与两阶段顺序

| 阶段 | owner 范围 | 主要落地与交接条件 |
| --- | --- | --- |
| A：Server | 后端开发独占 `apps/server/src/modules/identity-links/`、`apps/server/src/modules/registration/`、新增 `apps/server/src/modules/external-accounts/`、`apps/server/src/create-services.ts`、`apps/server/src/http/service-handlers.ts` 与相关 `tests/identity-links/`、`tests/registration/`、`tests/contract/`。Cfx protocol 文件只为实际适配编译需要修改，不更改协议语义。 | 先迁移取消 handler 与回归；再迁移账户规则与 grant 快照；最后修正 provider 匹配。保持现有 HTTP Contract、数据库 schema、migration 不变。跑定向 PostgreSQL/HTTP Contract 测试及 repo 要求的 typecheck、test、build。经独立审查并修复 P3 及以上后才作为可提交阶段交给 commit owner。 |
| B：Web | 前端开发独占 `apps/web/src/auth/`、`apps/web/src/registration/`、`apps/web/src/settings/`、`packages/components/src/auth/IdentityLinksPanel*` 与对应测试。 | 先共用第三方结果与安装锁，再改按 provider 展示。依赖阶段 A 的行为固定及现有生成 Client；覆盖登录页、注册页、Modal、设置换号与解绑影响。定向测试、typecheck、build 和真实浏览器状态检查后独立审查，修复 P3 及以上，再交给 commit owner。 |

并行开发时两个阶段不共享编辑文件；`api/`、`packages/api-client/src/generated/`、`apps/server/src/db/schema.ts`、`apps/server/drizzle/` 不在本 RFC 变更范围。Reviewer 与测试人员只审查/验证，不兼任自己改动的独立审批。阶段边界是可验证、可回退的本地提交边界，并非线上发布。

## 验证、失败处理与回退

- 01：真实 HTTP 取消保持原状态码和 `CfxCancellation` schema；三次取消后第四次可开始；外来浏览器取消返回原错误且容量不释放；consumed 等待账号锁期间取消返回 consumed，预留到事务结束；重复取消与无关联 intent 的普通 Cfx 取消仍正常。
- 02：通过账户规则 seam 和真实 PostgreSQL 测试已关联登录、邮箱重复、未关联 grant、主动关联、同 subject 并发建号、解绑/重链及账号停用竞争；重启后凭持久 grant 完成注册，账号及关联一次提交；原 Cfx 协议测试保证消费一次性、浏览器绑定、`expectedAttemptId` 与禁用时无协议资源。
- 03：同一共享流程测试三种结果、取消及卸载迟到响应、旧会话撤销等待期间双入口锁定、跨标签 token 改变、安装失败与 retry；登录页/注册页/Modal 集成测试呈现及导航，SSO 路径确认不出现 Cfx。
- 04：Server raw handler 和 HTTP 响应验证按 provider 匹配且保持三项顺序与禁用常量；Web 用打乱输入顺序确认仍显示对应 provider；社区影响加载中/失败/有影响，Cfx disabled 解绑，换号/退出旧响应隔离，POST/DELETE 响应丢失后的 GET 校准，申请及成员资格不变。
- 若 HTTP Contract 或 operation 实际变更，停止本 RFC 的无 Contract 变更路径，先走 Contract-first 评审、`pnpm api:lint`、`pnpm api:generate` 及双向 contract 测试。当前提案不需要这些变更；仍执行 `pnpm api:check` 作为兼容性门槛。

回退以 A、B 两个本地提交为单位；B 可单独回退到原页面流程，A 可在未引入持久结构变化时回退到原服务装配。回退后仍需跑取消容量、注册 grant 重启与关联唯一性定向测试。不要 reset 开发数据库；本期没有数据回填或自动 migration。开发数据库、真实 Cfx 回跳、邮件、浏览器和部署验收分别报告，自动测试不能代替外部验收。

## 风险与备选

| 风险 | 控制与检测 |
| --- | --- |
| 取消协调移走后，Cfx 路由 guard 或 operation 映射丢失 | 保留 `cancelCfxAttempt` 的单一登记及 Cfx `onRoute` guard；coverage 和真实 HTTP 取消测试验证。 |
| 可信证明被伪造或重放 | 仅服务端 adapter 生成内部可信对象；Cfx ticket 在同步调用中消费一次；grant 从数据库锁定行恢复；协议与重启用例验证。 |
| 重构破坏锁顺序或重复账号/关联 | 保持先账号锁、再检查当前关联与会话、最终依赖数据库唯一索引；真实 PostgreSQL 竞争测试验证。 |
| 前端取消后新 token 由迟到结果覆盖 | generation、AbortSignal、存储 owner 三层复核；跨入口及卸载测试。 |
| 社区影响读取失败被误认为安全解绑 | 明确未知状态，允许继续按既有确认语义解绑，提供重试；测试成员资格未改变。 |

备选一是只删 `preSerialization` hook，让普通 Cfx 取消不触达 intent；已有关联容量回归直接反证。备选二是在现有注册服务外加一个薄转发层；账户决策、grant 快照和建链仍分散，未解决第 02 项。备选三是立刻开放 Google/QQ 或放宽 subject/邮箱/Contract；缺少真实提供方协议与已接受的数据决策支撑，且会扩大本期风险。当前方案保留单一真实 adapter，同时完成可观察的内部规则集中和展示整理。

## ADR 与未决项

若独立架构审查接受账户规则新 owner 和取消 operation 的业务归属，应在实施稳定后由 ADR owner 判断是否需要记录新的跨模块决策；已有 `.ai/decisions/auth/01-public-registration-and-community-access.md` 与 `.ai/databases/decisions/08-account-identity-and-community-membership.md` 的业务规则不改变。若只属本期代码组织，RFC 与实现可作为记录，不新增 ADR。

目前没有阻止阶段 A 或 B 开始的实质未决决策。第二个真实提供方的协议、subject 与邮箱可选性、Contract 及 migration 属于未来独立设计，不得在本期隐式决定。
