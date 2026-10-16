# 注册错误的归属与步骤交接

_最后更新：2026-10-12_

公开注册的邮箱、验证码和资料表单各自持有 React Hook Form 错误。`apps/web/src/registration/PublicRegistrationFlow.tsx` 负责请求分支和固定文案，不保留已显示表单错误的第二份 state。共享验证码与资料表单仍位于 `packages/components/src/auth/InvitationForms.tsx`，文件名不表示退役邀请协议仍可用。登录的 AuthFormHandle 不受注册专用 handle 影响。

## 单一展示入口

邮箱注册失败、重发失败和完善资料的非字段问题进入目标表单的 `root.server`。共享反馈组件只负责展示，不解析 HTTP 状态或异常。

REGISTRATION_CODE_INVALID 属于验证码 FieldError。重发失败是验证码表单根错误，不能把验证码标为无效，也不能开启“重试验证”。发送的 Retry-After 只延长重发冷却；仅 REGISTRATION_CODE_LOCKED 延长验证锁定。否则重发过快会错误阻断已有的有效码。ErrorPanel 的布局与播报约束见 `.ai/knowledge/components/error-panel.md`。

同一表单失败不重复发送 ExMessage.error；注册完成使用 ExMessage.info。等待时间必须有限且为正，不回显底层异常。

## 请求与步骤的所有者

新流程不再自动消费旧邀请 URL。发码成功后才挂载验证码表单，验证成功后才挂载资料表单；本次失败写入发起操作所属的当前表单。不可用通用 error effect 把发送失败误交给验证码字段。

三个步骤使用各自的 handle ref。响应须匹配 mounted 与 generation；编辑邮箱、返回、关闭或切换使旧响应及 grant 失效，不能恢复旧资料。重发失败保留原 challenge 和已输入验证码；只有重发成功才清空验证码。注册 grant 只在内存保存，StrictMode 的即时重订阅不丢失初始 Cfx grant。

提交前清除相关错误，验证失败由修改输入或显式重试触发，不由重渲染自动重试。验证授权与入口清理边界见 `.ai/architectures/web/authentication-flow.md`。

## 证据与验证层级

对应组件和流程测试使用真实表单，覆盖错误归属、两种 presentation、重发冷却、StrictMode、关闭/返回及迟到响应。API 边界由替身控制；Cookie 链路、真实数据库与外部邮件/Cfx 必须分别验收。
