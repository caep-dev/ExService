# Cfx 身份模块验证

`tests/cfx/` 验证正式模块；既有 `tests/cfx-login/` 是独立的前期探针，不作为新模块验收替代。

自动测试：`pnpm exec vitest run tests/cfx tests/contract/cfx.test.ts --maxWorkers 2`。运行配置接线测试：`node --test --test-name-pattern "Cfx configuration" scripts/runtime/settings.test.mjs`。

真实 Cfx 验收：`pnpm exec vitest run --config tests/cfx/live.config.ts`。该显式 runner 使用临时 PostgreSQL Testcontainers 和真实 Cfx 模块；不读取开发数据库或根运行秘密。终端给出只监听回环地址的随机本地页面，打开后前往 Cfx 明确授权 `session_info,read`，复制加密 payload 并在页面提交。须在十分钟内完成。

runner 通过五项正式 operation 中的创建、手动完成、查询取得结果，并在同一进程调用 `consumeIdentity()`，验证第二次消费被拒。四项资料写入已忽略的 `.local/cfx-identity/live-identity.json`；脱敏结论写入 `.local/cfx-identity/live-result.json`。不在日志输出邮箱、Key、nonce、payload 或 ticket，不增加公共消费 endpoint。runner 的本地 HTML 是测试辅助入口，不接入 Website 页面。

自动化 production callback 测试只能验证处理逻辑；实际 HTTPS 域名、Cfx 接受动态 callback query 及代理/APM 日志仍须单独验收。本阶段不部署。关闭 runner 释放临时服务和数据库；远端 User API Key 不会自动撤销。
