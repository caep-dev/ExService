# Cfx 基础身份的消费与运行边界

_最后更新：2026-10-12_

`apps/server/src/modules/cfx/` 提供外部基础身份证明，不创建 Website 账号、本站会话或持久身份映射。HTTP 形状以 `api/openapi.yaml`、`api/paths/cfx.yaml` 和 `api/schemas/cfx.yaml` 为准；模块类型复用生成 Contract，业务插件暴露 `cfxServices`，API 插件在统一 Glue 前安装守卫。

默认关闭；只有 `CFX_ENABLED=true` 才启用。根 runtime 只向 Server 传 `CFX_ENABLED`、`CFX_APPLICATION_NAME`，以显式 development/production 选择 manual/redirect，并将 `PUBLIC_ORIGIN` 映射至受信 `SERVER_PUBLIC_WEB_BASE_URL`。服务不会从请求 header 拼接回调。关闭时不启动 timer、RSA 或论坛请求。

回调 GET 会完成授权，不能把 Fastify 为 GET 自动注册的 HEAD 当作只读探测。Cfx API 守卫在读取浏览器上下文与调用完成服务前拒绝回调 HEAD，返回 405 与 `Allow: GET`，保留 pending 状态供随后 GET 完成。`tests/contract/cfx.test.ts` 通过真实 Contract、Glue 与 handler 验证此顺序。

查询展示的四字段 JSON 不是后续业务的认证输入。未来 Server 业务应通过 `apps/server/src/modules/cfx/api/browser-context.ts` 的 `browserContext(request)` 从真实 Cookie 取得上下文，再调用 `cfxServices.consumeIdentity({ context, identityTicket })`。消费同步迁移 ready 至 consumed，清除身份与 ticket；并发恰好一次成功，后续事务失败不会恢复 ticket。不能接受 body 中的绑定或身份来代替消费。

状态仅在当前进程有效，重启失效。授权、结果、最小终态和绑定分别受独立期限约束，内部使用单调时钟；查询不续期。所有记录、counter、创建预留、RSA/处理槽有界，容量不足显式拒绝，不驱逐有效凭证。预算集中在模块 `config.ts` 与 `rate-limiter.ts`，不是生产吞吐承诺。

消费方若拥有指定授权流程的意图，必须向 `consumeIdentity` 传入 `expectedAttemptId`。基础服务在同步消费前将其与票据索引找到的真实 attempt 比较，不能以客户端同时提交 attempt 和 ticket 证明两者属于同一次授权。不同 attempt 即使共享浏览器 Cookie 也返回 `CFX_IDENTITY_TICKET_INVALID`，不消费被误传的票据；不传该参数的普通消费保持原有语义。回归通过真实 OAEP 及同浏览器两次 ready attempt 验证，外部论坛请求是替身。

取消、过期和关闭先失效任务版本，再中止请求；迟到结果不能恢复 ready。异步 RSA 不能强制取消，生成槽保留到真实工作 settle，`close()` 等待它完成。业务插件的 preClose/onClose 共用关闭 Promise；import 和 factory 本身不创建生命周期资源。

论坛只接收固定地址的两个认证 GET，使用同一 Key/clientId，拒绝 redirect，限制 JSON 响应大小并中止超时。主邮箱不自动具有 email_verified 语义；头像只规范化 URL，不下载。RSA 使用系统 OAEP-SHA1，不降级 PKCS#1；本地引用释放不能证明堆内存完全清零，也不表示论坛远端 Key 已撤销。

Fastify 构造时的 `apps/server/src/http/shared/request-logging.ts` 覆盖请求、响应与异常 serializer，自动 incoming 日志已不含 query、Cookie、body 或异常原文。反向代理和 APM 不在这一保护范围内，正式 HTTPS 验收须独立核对。真实授权 runner 与验收边界见 `tests/cfx/README.md`；自动 HTTP 测试不证明真实 Cfx OAEP 或实际域名回跳已通过。
