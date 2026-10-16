# ExWebsite

本仓库以单份 HTTP Contract 驱动 Web、生成式 Client 和唯一 Fastify Server。Server 使用独立的 PostgreSQL `exre` 数据库；目前仍处开发阶段。

_最后更新：2026-10-16_

## Language

**Contract（API Contract）**:
前端与 Server 共同遵守的唯一 HTTP API 事实来源。任何一方都不得在 Contract 之外新增路径、字段或错误格式；实现只能从 Contract 派生行为或类型。
_Avoid_: 接口文档、Swagger 文件、示例 API

**operation**:
Contract 中一个具体的「HTTP 方法 + 路径」行为单元。它是 Contract 与实现之间的最小交付单位。
_Avoid_: 接口、路由、endpoint 定义

**operationId**:
把一个 operation 绑定到其实现者（handler）的稳定标识。Service handler 是否被注册，以及覆盖检查是否通过，都以它为准；文件位置不参与解析。
_Avoid_: handler 名、路由名、函数名

**Server**:
本仓库唯一的 Fastify 服务，按 Contract 注册路由并实现行为。当前单实例开发拓扑不意味着已具备公网生产部署条件。
_Avoid_: Mock Server、临时后端、PHP 接管服务

**开发数据库**:
独立的 PostgreSQL `exre` 数据库，由环境变量明确指定；不与 Hydra 共用数据库。自动测试使用独立容器和隔离 schema。
_Avoid_: Mock SQLite、生产数据库、共享测试库

**健康检查**:
Server 自身可用性的最小信号。它表示进程已完成监听前置检查，不表示所有业务流程已经验收。
_Avoid_: 存活探针、业务就绪检查、状态接口

**envelope（错误 envelope）**:
所有失败响应的统一外壳。Contract 只约束它的外壳形状；具体的错误码取值属于实现侧的约定。
_Avoid_: 错误对象、错误详情、error 结构

**migration**:
对 PostgreSQL 应用结构的可执行变更单元。它只能由显式命令应用，服务启动不会生成或应用它。
_Avoid_: 建表脚本、schema 变更、SQL 文件

**baseline migration**:
从空 `exre` 数据库建立当前有效业务结构的首条 PostgreSQL migration；不回放旧 SQLite 历史。
_Avoid_: SQLite 基线、历史数据导入

**受控重置**:
开发专用命令：显式确认 `exre` 后，核验回环地址、连接身份和对象归属，清理本应用结构并重新应用基线；不删除头像目录，也不触及其他数据库。
_Avoid_: 清库、重置环境、删除数据库

**共享 Client**:
前端发起 HTTP 请求的唯一通道，由 Contract 生成的类型支撑。它不定义 endpoint，只承载调用。
_Avoid_: API 封装、请求库、SDK wrapper

**API base URL**:
前端请求前缀。开发环境缺省 `/api`，Vite 将请求代理到唯一 Server。
_Avoid_: 接口域名、服务地址、代理地址

**破坏性 Contract 变更**:
会使既有调用方失效的 Contract 修改（例如删除或重命名 operation、收紧必填字段、改变响应类型）。当前没有版本策略或兼容层，因此这类变更必须单独评审。
_Avoid_: 不兼容改动、大改动、breaking

**Draft-07 兼容子集**:
Contract 中 schema 允许使用的 JSON Schema 关键字范围。它由运行时校验器的语义决定，而不是由 OpenAPI 版本号决定。
_Avoid_: JSON Schema 子集、受限 schema、简化 schema

**加入申请**:
已登录的平台账户向指定社区提交资料后、等待人工审核的记录，与下文“社区申请”同义；历史匿名申请保留只读。
_Avoid_: 临时账号、注册会话

**邀请资格**:
旧邀请流程的建号资格，现仅保留历史事实；对应 HTTP 入口已退役，不能继续授权建号。
_Avoid_: 登录资格、账号权限、邮箱认证结果

**完善凭证**:
旧邀请流程的短期建号授权，切换时清除材料；当前使用下文“注册授权”，两者均不属于本站会话。
_Avoid_: 登录 token、注册会话、SSO token

**投递尝试**:
一次注册验证码邮件的交付记录，与账号创建及社区审核事实分别表达；旧邀请投递只读保留。
_Avoid_: 审核结果、邀请资格

**用户名（显示名称）**:
注册界面中的用户名沿用 `nickname` Contract 字段，允许重复，不作为登录标识；账号仍通过邮箱登录。旧文案称为昵称。
_Avoid_: 唯一用户名、用户名登录

**本人资料 snapshot**:
已验证本站会话读取到的当前账号资料，包含仅本人可见的登录邮箱；它不作为公开用户资料响应。
_Avoid_: 公开资料、会话缓存

**社区身份组**:
本站账号可被明确授予的身份分组，以稳定 `code` 标识。admin 用于平台配置管理，不隐含社区审核授权，也不代表游戏角色或 FiveM 权限。
_Avoid_: 游戏权限组、角色权限

**普通身份**:
正式账号没有显式社区身份组成员关系时的默认身份；未登录者不因此成为普通用户。
_Avoid_: `general` 成员关系、匿名用户身份

**管理员组（`admin`）**:
只通过受信任流程显式授予的平台管理员身份组；注册不会自动加入，社区配置与审核授权管理仍由服务端复核。
_Avoid_: 注册默认权限、游戏管理员权限

**本站会话**:
普通登录成功后由 Server 签发、浏览器通过 Bearer 使用的 7 天固定期限会话。原始 token 只交付给浏览器，数据库只保存摘要；它与 SSO 完成结果是两类状态。
_Avoid_: 登录信息、用户缓存、SSO token

**SSO 请求**:
由本地显式 CLI 创建、等待浏览器确认某个账号的短期请求。接收页只能检查或完成它；完成不会签发本站会话，当前也没有生产发起方或轮询协议。
_Avoid_: SSO 会话、回调 token、外部登录凭据

## 公开注册与社区模型

业务规则集中于 `.ai/decisions/auth/01-public-registration-and-community-access.md`，标识与数据约束集中于 `.ai/databases/decisions/08-account-identity-and-community-membership.md`。

**Exre 账户**:
用户在总体服务中的平台身份，承载登录凭据、本人资料及业务关系。
_Avoid_: 单个社区账号、Cfx 账号、邮箱主键

**第三方关联**:
外部平台已经证明的身份与 Exre 账户之间的关系，用于第三方登录或提供社区所需身份信息。
_Avoid_: 关注、第三方邮箱自动合并、QQ 联系字段

**社区**:
游戏服务器的成员申请和审核管理单位，与当前“社区身份组”分开表达。
_Avoid_: `community_groups`、平台账户、默认权限组

**社区申请**:
新模型中已登录的 Exre 账户向指定社区提交的加入申请，承载资料快照和审核事实。
_Avoid_: 注册申请、匿名申请认领、注册邀请

**社区成员资格**:
社区通过审核授予 Exre 账户的成员关系，与外部身份关联及当前要求的满足情况分别表达。
_Avoid_: Cfx 关联、游戏连接凭证、平台管理员身份

**社区要求**:
申请或使用该社区时需要满足的账户关联条件，由社区配置决定。
_Avoid_: 审核结果、成员资格、全平台注册要求

**社区审核员**:
在指定社区范围内被明确授权处理申请的人，与平台管理员的管理职责分开表达。
_Avoid_: 所有社区管理员、普通注册账户、游戏管理员

**注册授权**:
公开注册中完成邮箱验证或外部证明后，用于完善账户的短期许可，与已退役的邀请完善凭证区分。
_Avoid_: 本站会话、游戏准入、永久关联

**网站侧就绪状态**:
网站对社区成员资格和当前关联要求的组合展示，不证明真实游戏端已经接入或放行。
_Avoid_: 已入服、游戏验收通过、公网生产可用

## 独立身份系统

**统一身份**:
Website 是账号和本站会话的事实来源；Hydra 承担 OIDC 协议，客户端按显式批准的配置接入。
_Avoid_: 把本地 CLI SSO 当成 OIDC、共享数据库、默认应用

**身份客户端**:
由可信配置精确登记的应用，拥有独立 clientId、回调、scope 和秘密。显示名仅用于界面，不参与授权。
_Avoid_: 公开自动注册、任意回调、登录即拥有应用权限

**cleanup-only 目标**:
仅供已有 outbox 事件投递的原目的地，不具有新 OIDC 授权或内部会话调用权限。
_Avoid_: 备用登录客户端、当前秘密回退

**会话绑定**:
clientId、Hydra sid 与稳定本站 sessionId 的关联；普通退出只影响当前会话及其绑定，停用账号使既有会话失效，恢复不复活旧会话。
_Avoid_: 按用户批量清理全部设备、以邮箱关联身份

**应用撤销通知**:
在完成 Hydra 撤销之外，可选向已配置的应用 endpoint 投递原 eventId/sessionId。未配置或未完成通知不证明外部应用实时退出。
_Avoid_: 无条件跨应用同步退出、成功请求即外部验收

身份结构见 `.ai/architectures/identity/integration-boundaries.md`；数据规则见 `.ai/databases/data-model.md`。
