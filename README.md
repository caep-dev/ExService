# ExWebsite

Website 使用独立 PostgreSQL `exre`；Hydra 提供 OIDC 协议并使用独立 `hydra` 数据库。Docker 运行 PostgreSQL、Hydra，Website 在宿主机开发监听。文档入口现为主站建设中页面。当前为本地开发阶段，不部署上线。

## 日常启动检查单

已有环境按以下顺序执行：

- [ ] Docker Desktop/daemon 已启动：`docker info` 能连接引擎。
- [ ] 根 `.env.local` 已填写现有配置，`RUNTIME_PROFILE=local`。保留原账号、密码、密钥、库和存储路径。
- [ ] 执行 `pnpm service:start`，直到显示“后台依赖已就绪”。
- [ ] 执行 `pnpm service:status`，确认 PostgreSQL、Hydra 都在运行。
- [ ] 执行 `pnpm dev`。启动检查通过后显示网站入口，默认 `http://127.0.0.1:8080/`。

启动失败会直接输出检查项、错误点、相关配置键和下一步。修正该项后重试；不要重复执行初始化或重置来绕过错误。Ctrl+C 结束应用，后台依赖继续运行；`pnpm service:stop` 停止本项目依赖并保留持久数据。

终端提示自动使用颜色；设置 `NO_COLOR=1` 可关闭。重定向输出和保存的日志保持纯文本；`pnpm dev --verbose` 显示完整日志时间。

## 首次准备检查单

仅全新环境执行；已有环境跳过已经完成的项。

- [ ] 安装 Node 22.12+、pnpm 11.9.0、Corepack 和 Docker Compose。
- [ ] 安装根依赖：`pnpm install --frozen-lockfile`。
- [ ] 按根 `.env.example` 填写 `.env.local`：Website 与 Hydra 数据库组件字段及原始秘密。库名分别为 `exre`、`hydra`，各自使用独立 owner；应用只读取根配置，进程变量优先。
- [ ] 显式创建独立 Website `exre` 及其 owner，然后执行 `pnpm db:migrate`。
- [ ] 执行 `pnpm infra init`，显式准备 Hydra 数据库及 migration；该命令不会创建 Website `exre`。
- [ ] 执行 `pnpm service:start`。如需接入应用，在 `IDENTITY_CLIENTS_JSON` 配置明确的客户端，再执行 `pnpm infra clients`。默认 `[]` 无需登记，不创建默认应用。
- [ ] 执行 `pnpm dev`。

公开注册不要求社区审核。邮箱注册需要邮件适配器，缺失时明确返回不可用；仅本地开发可显式配置 `SERVER_REGISTRATION_MAIL_SIMULATOR=true`，从专用终端通道取得测试验证码，该通道不代表真实投递。Cfx 路径遵守已有 Cfx 配置；两种注册方式均须设置密码。Google、QQ 暂未开放。

普通启动只检查就绪状态，不创建库、迁移、重置、登记 client 或授予管理员。已有环境切换旧 URL 配置时，先核对原连接目标和凭据，再显式执行 `pnpm infra convert`；它备份配置并保留原值，不迁移数据。更换持久卷、PostgreSQL 版本、issuer 或已有凭据需要独立维护，不属于启动检查单。

旧 Outline 环境的资源清理是独立维护：`node scripts/runtime/retire-outline.mjs --plan` 缺省只读，需要原配置及归属证明。清理前保留原配置和资源记录，不能删除证明或重置 PostgreSQL/Hydra 来绕过核验。维护边界见 `.ai/architectures/runtime/runtime-boundaries.md`。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 启动/停止后台依赖 | `pnpm service:start` / `pnpm service:stop` |
| 查看状态/日志 | `pnpm service:status` / `pnpm service:logs [postgres\|hydra]` |
| 开发监听 | `pnpm dev` |
| Website 显式迁移 | `pnpm db:migrate` |
| 注册切换前只读历史盘点 | `pnpm db:registration-inventory` |
| Hydra 显式迁移 | `pnpm infra migrate` |
| 显式登记身份客户端 | `pnpm infra clients` |
| 自动测试/监听测试 | `pnpm test` / `pnpm test:watch` |
| 构建 | `pnpm build` |
| Contract 与类型检查 | `pnpm api:lint` / `pnpm api:generate` / `pnpm api:check` / `pnpm typecheck` |

测试使用临时数据库，不连接开发库；Build 不连接数据库或启动 Docker。自动测试、本机生命周期、浏览器和部署验收分别报告。

## 工程入口

`api/openapi.yaml` 与 `api/paths/`、`api/schemas/` 是唯一 HTTP Contract 源，统一生成 `api/generated/openapi.json` 和 Client 类型；`apps/server/` 是唯一 Website Fastify Server；Web API 调用只经 `packages/api-client/`。`pnpm dev`、`pnpm test` 和 `pnpm build` 先生成 Contract，生产启动只读取已有 JSON。`packages/common/` 通过 `@workspace/common/node/identity-config` 为 Server 与 runtime 提供共享的纯身份配置解析。ExUI 使用 pnpm lockfile 锁定的 registry 包。

开发规则见 `AGENTS.md`，模块知识从 `.ai/README.md` 查阅，运行与资源边界见 `.ai/architectures/runtime/runtime-boundaries.md`，身份客户端边界见 `.ai/architectures/identity/integration-boundaries.md`。
