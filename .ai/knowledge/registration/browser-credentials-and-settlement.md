# 注册浏览器凭证与异步资源边界

注册与 Cfx 都依赖 HttpOnly 浏览器绑定 Cookie，Bearer 不能代替它。Website 的 `apps/web/src/api/client.ts` 显式启用 SDK sameOriginCookies；SDK 默认仍 omit，该选项使用 Fetch same-origin，跨源不发送 Cookie。Axios fetch adapter 的 withCredentials=false 会变成 credentials=omit，连同源 Set-Cookie 都不能正常保存；只有请求 mock 的 UI 测试无法发现此问题。应在真实浏览器验证创建、查询与邮箱 verify 的调用链。

注册邮件适配器的超时结束对外等待，但不能当作真实工作已经结束。四个邮件槽位占到适配器实际 settle；迟到结果不能把已 failed 投递改回 sent。PasswordHasher 与注册服务分别约束密码计算和 grant processing，关闭等待实际工作完成后才移交数据库清理。实现位于 `apps/server/src/modules/registration/service.ts`，生命周期归 `.ai/architectures/server/authentication-lifecycle.md`。

同源注册及本人关联 guard 使用单独可信 publicOrigin，Cfx disabled 仍可邮箱注册、查询关联和解绑。所有 Cookie、ticket、grant、验证码和密码有各自的消费边界；注册 grant 与 Cfx ticket 只保存在当前内存流程，不进入 URL、router state 或持久存储。
