# Exre 公开注册与社区申请交接

日期：2026-10-12。

本交接供新会话继续技术评审和后续落地准备。用户指定输出到 `.notes/todos/`，覆盖 handoff skill 默认写入操作系统临时目录的约定。

## 当前阶段与授权

产品讨论、设计文档、RFC 草稿和稳定决策提取已经完成；尚未实现公开注册及社区新流程。

- 用户已全文确认设计，并明确同意将稳定结论写入 `.ai/`。
- RFC 仍待技术评审；用户没有明确批准它的全部技术细节，也未要求开始实施。
- 没有执行提交、推送、数据库迁移、重置或部署；下一会话不能把设计批准或本交接当作这些操作的授权。
- 源设计头部仍写“等待用户全文审阅”，因为 RFC 交接要求保持源文件不变。实际全文批准已在对话中收到，不要仅凭该旧状态重新要求用户批准产品方向。

用户没有指定下一会话的实施任务。默认先阅读和评审已有 RFC；开始实现前需要新的明确指令。

## 已有成果：按路径阅读，不重写

| 成果 | 路径 | 用途与状态 |
| --- | --- | --- |
| 已批准设计 | `.notes/public-registration/specs/2026-10-12-public-registration-and-community-membership-design.md` | 产品决策的源依据；全文已确认，保持原文。 |
| 技术 RFC | `.notes/public-registration/rfcs/public-registration-and-community-membership-rfc.md` | 目标模块、24 个拟议 operation、schema、凭证、并发、通知事务、历史迁移及验收；待技术评审。 |
| 业务决策 | `.ai/decisions/auth/01-public-registration-and-community-access.md` | 注册、登录、关联、社区准入、审核范围；已接受目标，尚未实现。 |
| 数据决策 | `.ai/databases/decisions/08-account-identity-and-community-membership.md` | 账户标识、关系唯一性、申请归属及历史保留；已接受目标，新增模型尚未实现。 |
| 知识导航 | `.ai/README.md`、`.ai/decisions/README.md` | 已登记上述目标决策。 |
| 术语和模型入口 | `.ai/CONTEXT.md`、`.ai/databases/data-model.md` | 已区分当前邀请流程和目标模型；当前实现说明没有改写成新流程。 |

不要把 RFC 中的拟议接口当作当前 API。实际 Contract 仍在 `api/openapi.yaml`；已有 Cfx 基础证明能力的消费边界见 `.ai/knowledge/cfx/identity-lifecycle.md`。完整业务选择已经在上述成果中记录，本交接不重复。

## 工作区与边界

交接时分支为 `feat/cfx-login`，HEAD 为 `098d4be`；接手后重新核对实际 Git 状态。

本任务的未提交成果包含 `.notes/public-registration/`、两条新增 `.ai/` 决策及其索引、术语和模型入口更新。本交接新增在 `.notes/todos/`。已核对的源码和 Contract 没有因本任务改动。

`.notes/cfx-login/`、`.notes/google-login/`、`tests/cfx-login/` 在本任务开始前已经存在未跟踪工作，不属于本次公开注册文档的新增范围。保留这些内容，不批量暂存、移动或清理；第三方配置和授权证据可能含敏感材料，不批量读取或提交。本交接不保存任何凭据、用户邮箱或原始授权 payload。

开工先读 `AGENTS.md`、`.ai/README.md` 和相关模块资料。仓库路径采用根目录相对的行内代码。交接时没有 `.codegraph/`；若接手时已存在，按项目规则先用 CodeGraph 定位代码。贡献与测试规则分别从 `CONTRIBUTING.md` 和接手时存在的 `TESTING.md` 获取。

## 下一会话建议顺序

1. 阅读已批准设计、两条稳定决策和完整 RFC，保持已确认的产品语义；不要把技术提案未经评审直接标为接受。
2. 对照当前源码审查 RFC 第 3–7 节的模块依赖、API、持久授权、锁顺序及通知事务，和第 9–10 节的非空旧库迁移、退役与回退边界。确认后修订 RFC，不重复创建另一份产品规格。
3. 处理 RFC 第 13 节的交付门槛：Contract 变更落地前确认具体版本值；实际 migration 前显式清点旧库；正式能力验收前验证真实 Cfx 回跳及邮件。不同门槛不能都误当作实现前置条件，也不能跳过后声明验收通过。
4. 用户明确要求实施后，再制定实施计划并核对工作区隔离，按 Contract-first 工作流推进。设计讨论已完成，除发现矛盾或用户改变需求外，不重新访谈已确认规则。
5. 实施完成后按真实行为更新当前架构和数据模型文档，并分别报告自动检查、浏览器、外部授权/邮件、数据库切换结果。游戏端接入仍是独立后续项目。

已沉淀的稳定约束与拟议物理结构分开阅读：前者是接受的设计，后者仍需技术审查。用户此前授权的是记录目标决策，并不授权立即改 schema 或运行迁移。

## 验证记录与已知缺口

- 文档格式、新增引用、拟议 operation 唯一性和 whitespace 检查已通过；原 spec 在 RFC 和 `.ai/` 提取期间的 SHA256 保持一致。
- `.ai/` 新增引用检查通过。检查发现当前数据模型已有一处通知设计文件引用在本工作区缺失，已确认它存在于原 HEAD，属于基线问题；参阅 `.ai/databases/data-model.md` 的持久通知模型段。本次未修复该无关历史引用。
- 头像数据目录是运行时路径，当前不存在不能据此判断文档链接或业务测试失败。
- 本任务没有执行 API lint/generate、typecheck、应用测试、build、浏览器或数据库验收，因为交付范围是设计和文档。不能据此宣称新功能通过测试。
- 未读取实际开发库，未知旧申请数量和是否存在迁移冲突；真实 Cfx、邮件及游戏入服验收不属于已完成结果。

## Suggested skills

下一 agent 按实际阶段调用当前可用的 Skill 工具或读取相应 SKILL.md：

- `technical-design-doc-creator`：审查和细化现有 RFC；保持已批准设计为依据。
- `codebase-documenter`：维护 `.ai/` 的归属、目标与当前实现状态。
- `superpowers:writing-plans`：仅在实施已获授权、RFC 已完成必要确认后，形成可执行计划。
- `superpowers:using-git-worktrees`：实施需要隔离时使用，先判断是否已位于 linked worktree，避免重复创建或搬走未提交成果。
- `superpowers:test-driven-development` 与 `superpowers:verification-before-completion`：实施时覆盖真实业务调用链，完成声明前核对实际检查结果。
- `superpowers:brainstorming`：仅在需求方向发生变化时重新讨论，不重开已批准的产品决策。

若后续明确要求提交或创建 PR，再使用对应 `commit`、`open-pr` skill；本次没有这项授权。
