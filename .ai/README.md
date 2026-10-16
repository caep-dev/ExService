# ExWebsite 持久知识库

本目录记录源码难以直接表达的模块边界、已接受决策、数据规则与运行陷阱。仓库以 `api/openapi.yaml` 为唯一 HTTP Contract；`apps/server/` 是唯一 Fastify Server，使用独立 PostgreSQL `exre`。当前仍是单实例开发阶段，不代表已可公网部署。

_最后更新：2026-10-16_

## 模块与入口

| 模块 | 代码路径 | 知识入口 |
| --- | --- | --- |
| API Contract | `api/openapi.yaml`、`api/paths/`、`api/schemas/`、`api/generated/openapi.json` | `.ai/architectures/api/contract-layout.md` |
| 生成式 Client | `packages/api-client/` | `.ai/decisions/api-client/01-generated-types-committed-and-read-only.md` |
| 共享组件 | `packages/components/` | `.ai/knowledge/components/ex-message-host-lifecycle.md`、`.ai/knowledge/components/error-panel.md`、`.ai/knowledge/components/tiptap-content-boundaries.md` |
| 共享纯逻辑 | `packages/common/` | `.agents/rules/common.md`；反馈内容接线见 `.ai/architectures/support-center/feedback-lifecycle.md` |
| Web | `apps/web/` | `.ai/architectures/web/authentication-flow.md`、`.ai/knowledge/web/invitation-error-handoff.md` |
| 通用内容与 About | `apps/web/build/content/`、`apps/web/build/about/`、`apps/web/src/content/`、`apps/web/src/pages/AboutUs/` | `.ai/architectures/web/content-rendering.md`、`.ai/knowledge/web/content-authoring.md` |
| Server | `apps/server/src/modules/`、`apps/server/src/domains/`、`apps/server/src/http/` | `.ai/architectures/server/request-lifecycle.md`、`.ai/architectures/server/authentication-lifecycle.md`、`.ai/knowledge/server/multipart-lifecycle-traps.md` |
| 公开注册与社区准入 | `apps/server/src/modules/registration/`、`apps/server/src/modules/identity-links/`、`apps/server/src/modules/communities/`、`apps/server/src/domains/join/` 及 `apps/web/` | `.ai/decisions/auth/01-public-registration-and-community-access.md`、`.ai/databases/decisions/08-account-identity-and-community-membership.md`、`.ai/knowledge/registration/browser-credentials-and-settlement.md` |
| Cfx 基础身份 | `apps/server/src/modules/cfx/` | `.ai/knowledge/cfx/identity-lifecycle.md` |
| 存储与 SDK | `apps/server/src/modules/storage/`、`packages/sdk/` | `.ai/knowledge/storage/lifecycle-traps.md` |
| 独立身份系统 | `apps/server/src/modules/identity/`、`packages/common/src/node/identity-config/`、`scripts/runtime/hydra-client.mjs` | `.ai/architectures/identity/integration-boundaries.md`；Common 消费规则见 `.agents/rules/package-common.md` |
| 运行配置与进程 | `scripts/runtime/`、`infra/runtime/` | `.ai/architectures/runtime/runtime-boundaries.md` |
| Contract Test | `tests/contract/` | `.ai/architectures/contract-tests/test-layers.md` |
| 持久通知 | `apps/server/src/modules/notifications/`、`apps/web/src/notifications/`、`packages/components/src/notifications/` | `.ai/knowledge/notifications/clear-preview-coexistence.md`、`.ai/knowledge/notifications/command-idempotency.md`、`.ai/knowledge/notifications/request-lifecycle.md`、`.ai/knowledge/server/query-string-type-enforcement.md` |
| Monica 项目协作 | Exre Delivery Squad | `.ai/architectures/monica-team/workflow.md` |

跨模块结构见 `.ai/architectures/overview.md`；业务术语见 `.ai/CONTEXT.md`；账号、社区申请与历史邀请数据规则见 `.ai/databases/data-model.md`；决策索引见 `.ai/decisions/README.md`。

## 支持中心

支持中心的已接受边界与实现范围见 `.ai/decisions/support-center/01-authenticated-support-and-clickup-view.md`，内容与会话接线见 `.ai/architectures/web/content-rendering.md`。反馈提交、恢复与维护接线见 `.ai/architectures/support-center/feedback-lifecycle.md`；真实 ClickUp 验收与本站实现分别核对。技术设计与 RFC 保留在 `.notes/support-center/`。

## 知识归属

| 位置 | 内容 |
| --- | --- |
| `.ai/CONTEXT.md` | 领域语言与术语。 |
| `.ai/architectures/` | 结构、依赖方向、请求与控制流。 |
| `.ai/decisions/`、`.ai/databases/decisions/` | 已接受选择及原因；过时选择标明取代关系。 |
| `.ai/knowledge/`、`.ai/databases/knowledge/` | 非显而易见的运行约束与失败模式。 |
| `.ai/databases/data-model.md` | 表的业务职责与数据规则，不复制物理 schema。 |
| `.ai/rules/` | `AGENTS.md` 指定的专项开发规则。 |

同一长期事实只在一个知识位置维护，其他文件引用它。设计、RFC 与实施计划保留在 `.notes/`；历史档案记录其当时背景，不作为当前运行指南。

## 核对来源

当前行为以 `api/openapi.yaml`、`package.json`、`apps/server/src/`、`apps/server/drizzle/`、`apps/web/src/` 和 `tests/` 为准。数据库目标与显式命令见 `.notes/archive/server-promotion/specs/2026-09-29-server-promotion-design.md` 与 `.notes/archive/server-promotion/rfcs/server-postgresql-migration-rfc.md`。文档不记录一次性任务输出、工作树状态或未经验证的生产能力。
