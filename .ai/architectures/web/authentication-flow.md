# `web` 模块：公开注册、社区申请与认证 UI

本文件说明共享认证 UI、应用流程和浏览器存储之间的边界。HTTP operation 与字段形状以 `api/openapi.yaml` 和生成 Client 类型为准。

_最后更新：2026-10-16_

## 责任分层

```text
packages/components
  登录与注册表单 / AuthModal / IdentityLinksPanel / CompleteJoinApplicationModal / JoinReviewDialog
          ↑ props 与回调
apps/web
  AuthFlow / PublicRegistrationFlow / useThirdPartySignIn / CfxAuthorization / AuthProvider / 路由页面
          ↓
  @workspace/api-client
```

共享组件只管理字段、校验、焦点和可访问状态。它不读取浏览器存储、不调用 API、不决定导航。`apps/web` 负责请求分支、token 生命周期、SSO 上下文和整页跳转。设置 Modal 与 `/account/profile` 通过同一个设置控制层读取、更新及上传本人资料，界面由共享组件接收值和回调。

登录、公开注册与申请表单使用 React Hook Form 与 Zod；服务端字段错误通过 setError 展示。邮箱、数字码和完善资料各有独立表单；Google、QQ 为禁用入口，不发请求。普通登录可选择 Cfx；专用 SSO 接收流程仍仅使用密码与确认，不接入 Cfx。

普通密码登录与 SSO 密码登录先在凭据表单点击“继续”，再于同一容器切换到图片验证码占位步骤。点击“登录”才调用对应 operation，不附加伪造的验证码凭证；公开注册不经过此步骤。

## 入口与容器

- 顶栏登录与注册使用受控 Modal；关闭会卸载当前流程。
- `/login` 使用 `AuthFlow`，`/register` 使用 `InvitationRegistrationPage`；两者位于 `RootLayout` 之外，不渲染站点顶栏或认证 Modal，复用认证背景与外围容器。
- 顶栏桌面与移动注册入口挂载同一个 PublicRegistrationFlow；完成后在原 Dialog 切到普通登录。关闭按当前桌面或移动触发器恢复焦点。
- 登录的“注册账号”在 Modal 内切到公开注册，独立页导航到 `/register`；社区页面位于 RootLayout 内。
- `/sso/success` 与 `/sso/*` 的兜底页面也位于 `RootLayout` 之外，不渲染站点顶栏；认证页面代码集中在 `apps/web/src/pages/AuthPage/`。
- 普通独立认证页通过左上角 Home 返回首页；带 `ssoRequestId` 的登录页面隐藏该入口。独立认证页与 SSO 成功页复用 `MeshGradient` 背景，共享组件不依赖着色器。
- 登录入口只要 URL 中出现 `ssoRequestId`，就必须通过格式与单值检查；空值、重复值或非法值显示无效入口，不能回退成普通登录。

图片验证码的取图与提交字段已在 Contract 中预留，真实校验启用前须单独决定有效期、重试规则以及要求凭证的版本策略。

## 社区申请与公开注册

`/join/rifling-911` 读取服务器社区要求及本人状态，两类入口各挂载独立 CompleteJoinApplicationModal。共享组件从 Zod 推导含 File 的草稿，以 RHF 管理字段、分步校验和文件；后退、关闭再打开保留对应类别的内存草稿及 File。提交在途保护关闭和重复提交，失败保留草稿，成功清空并锁定一次申请入口。任意已有申请状态关闭新提交。

联系方式只读展示服务器账户邮箱及名字，payload 仅 qq 与 form。匿名草稿通过 CommunityAuthentication 的 onSessionCreated 在原处继续；首次登录可采用该草稿，既有 owner 退出或换号立即清空。私有请求捕获 owner token 并显式传 Bearer，迟到请求不替换新账号数据。当前 Cfx 要求缺失时进入已有关联分区，再读取资格，客户端提示不能代替服务器复核。

报名表单的字段与提交状态由 ExUI `ExForm` 内部的 React Hook Form 实例持有，接入约束见 `.ai/rules/frontend-forms.md`。分步校验使用原字段路径的独立 Zod schema，复用完整提交 schema 的规则；未填写的后续字段不能阻止当前步骤继续，最终提交仍校验完整申请。可选预设字段的“其它”仅控制输入区域展开，提交值始终是实际答案字符串，不向 HTTP Contract 增加界面状态字段。证明附件的文件名在选择时由共享 Zod schema 校验；非法名称先在表单中提示，Server 仍独立校验上传文件，不以客户端校验作为信任边界。

Hero 图片来自 `apps/web/public/images/heros/join/rifling-911/`。构建时按文件名排序收集支持的图片格式；多张图片时点击背景循环切换，也支持聚焦背景后按 Enter 或空格，不显示独立切换按钮。画面上的申请按钮与结果查询链接独立响应，不触发切图；单张图片作为静态背景。图片切换尊重减少动态效果偏好。

`apps/web/src/join/client.ts` 将草稿映射为生成 DTO，以 JSON Blob 与 proofs File 构造 FormData，经生成 Client 提交带 communityId 的 operation。共享组件不复制 HTTP DTO 或访问 API。成功仅表示申请事务已完成，结果入口固定为 `/join/result`；“面试预约”仍为禁用占位。申请、审核、注册及通知的职责见数据模型。

`/join/result` 登录后分页读取当前 owner 的社区状态，选择社区查看申请、成员资格及当前关联要求；websiteReady 与审核结果分别表达。旧 email/code 参数清除并说明，不提供任意邮箱查询。分页、选社区、owner 变化及卸载使旧请求代次失效；结果不进入 URL 或持久存储。

PublicRegistrationFlow 在应用层控制 email、code、profile、registered。邮箱发码成功后挂载验证码表单，验证成功取得 grant 后挂载必填用户名和密码；邮箱只读。重发冷却使用服务器时间差，验证失败由输入或显式按钮重试，不由渲染循环驱动。错误归属集中于 `.ai/knowledge/web/invitation-error-handoff.md`。

旧 `/register?code=` 仅说明流程已调整并删除 code，不自动消费。数字码、密码、grant 和 Cfx ticket 只在内存保存，返回或关闭清理，不写日志、路由 state 或浏览器存储。

CfxAuthorization 支持本地手工加密结果与 redirect；授权在新标签打开，被拦截时保留再次打开入口。只有可见页面串行轮询，取消、owner 变化与卸载使旧 generation 失效。真实 ticket 交给 `apps/web/src/auth/useThirdPartySignIn.ts`，由生成 Client 请求 Cfx sign-in；显示的外部资料不能替代证明。该流程按 Contract 的 signed-in、registration-required、account-exists 三种结果作唯一 typed 分流，登录和注册容器只通过 presentation 回调决定导航、提示和资料完善。共享流程持有提交锁，直至本站会话安装结算；失效、卸载、owner 更换或父流程代次改变后，迟到结果不安装会话，内存中的 grant 与可重试结果被清除。会话变更携带来源；自身写入新 token、安装期间旧会话失效的 HTTP 同步和父容器正在安装密码会话的预期变化不误判为外部换号。专用 SSO 接收流程仍不挂载 Cfx。

注册成功清空敏感材料并使用 `ExMessage.info` 提示，随后一次性前往普通登录。页面 replace 到 `/login`，只用内存路由 state 传邮箱；弹窗切换原容器。手动前往登录或卸载清理自动切换计时器，不创建会话，不带入 SSO 上下文。资格检查与持续错误的通知规则统一见 `.ai/rules/frontend-notifications.md`。

入口 `apps/web/index.html` 在所有脚本和资源声明之前设置 `no-referrer`，避免旧邀请 URL 的邮箱和数字码进入资源请求的 Referer。Vite 会在该 meta 前注入开发脚本，因此 `apps/web/vite.config.ts` 还为本地开发服务设置 `Referrer-Policy: no-referrer` 响应头。URL 清理发生在 React 挂载后，不能替代加载前的入口策略；这些策略不会隐藏原始入口请求 URL。

浏览器绑定 Cookie 的真实传输约束见 `.ai/knowledge/registration/browser-credentials-and-settlement.md`。

## 本地申请审核

JoinReviewPage 从本人 review-access 取得明确授权社区，平台 admin 不隐含审核资格；列表、详情、决定及附件均使用对应社区路径与捕获的 token。过滤或社区变化重置分页，列表与详情各用代次拒绝迟到结果，每次打开重新读取。历史三种记录只读，当前两种记录按状态决定；服务器是最终授权依据。附件 401/403 清空受保护内容，要求显式重读授权，不继续展示旧详情。

共享 `JoinReviewDialog` 接收展示内容和回调，不复制 DTO 或调用 API。申请与审核两个 Tab、标题和底部动作固定，内容区滚动。关闭保留过滤与分页；原列表行仍存在时恢复查看按钮焦点，行已被审批移除时回到可聚焦的列表操作。已经提交的审批不会因关闭 Dialog 撤销，完成后刷新列表；只有仍对应当前选择的结果才更新详情和通知。审核人未记录时不伪造身份。

`/admin/communities` 使用服务器 isPlatformAdmin 提示管理资格，创建与编辑表单采用 RHF、Zod 和 ExUI。配置更新携带 expectedRevision；审核员列表分页，授予及撤销使用明确 UUID。页面不通过可见性授予权限，也不赋予管理员隐含审核范围。

## 本站会话

普通密码登录和 Cfx 登录共用 `apps/web/src/auth/session-install.ts` 的本站会话安装。若浏览器仍保存另一账号的 token，先由专用生成 Client 携带捕获的旧 token 撤销旧会话；此请求的 401 只同步当前浏览器会话，不抢先跳转登录页。明确的 `SESSION_INVALID` 表示旧会话已无效，可继续登录；其他撤销失败保留旧 token 并提供重试。成功撤销后若当前流程已取消，只清除仍与捕获值匹配的旧 token。写入前再次核对浏览器 token 未被其他页面替换，再把新 token 写入 `localStorage` 的 `exwebsite.auth.token`；成功写入后才整页导航或继续当前 OIDC challenge。`AuthProvider` 在启动与其他标签页 storage 事件后调用 `/auth/me` 恢复身份；浏览器存储本身不作为身份依据，旧 token 的迟到资料与错误不能覆盖后来保存的新会话。

明确的 `SESSION_INVALID` 只删除仍与本次请求匹配的 token，避免迟到响应清掉较新的登录；资料页读取或修改收到此错误时同步更新顶栏认证状态。临时网络错误保留 token 并显示可重试状态，资料读取失败也结束等待并允许重试。

主动退出由 `AuthProvider` 立即完成本地状态切换：删除 `localStorage` 的本站 token、当前标签页 `sessionStorage` 的 SSO 成功展示记录，清除 HTTP 客户端凭证和缓存的本人设置资料，关闭认证容器并切换为匿名。两种 storage 独立尝试清理，存储异常仍清除内存身份。已有身份查询的请求代次失效，不能恢复退出前的资料；主题等非认证偏好保留。

本地清理前捕获的 token 仅用于后台 `/auth/logout` 撤销请求，通过显式 Authorization 传递。API 拒绝、断网、超时或请求未完成均不阻止浏览器退出；请求结束不再修改本地身份，因此迟到结果不能清除后来登录的新会话。此路径不立即刷新页面，以免中断尚未送达服务端的撤销请求。本地退出不等于服务端撤销成功；跨服务会话撤销仍依赖服务端请求成功处理。

## 身份页面

`apps/web/src/App.tsx` 注册 `/identity/login`、`/identity/consent`、`/identity/logout` 和 `/identity/signed-out`。挑战页面通过生成的 API Client 检查或接受 Hydra challenge；已有有效本站 Bearer 可直接完成登录与授权，缺少会话时经现有登录 UI。挑战与当前 token 不匹配时重新开始，避免迟到响应将旧身份带入新会话。

身份密码登录将目标服务说明放在共享表单的标题区，通过可选 `description` 展示，并在验证码步骤继续保留；表单显示时不再叠加外围登录标题。页面底部的信息入口通过 `OidcSharingDialog` 打开独立 ExUI Dialog，只描述 challenge 检查返回的 scope：`openid` 为账号身份，`profile` 为基本资料，`email` 为邮箱；每项使用图标、标题与用途说明，原始 scope 收在弹窗内的技术详情。其他 scope 保留原标识，不推断权限。关闭、Esc 或“知道了”返回入口并保留表单输入；该弹窗只供查看，不增加授权确认步骤，已有会话仍按原流程自动继续。

生成 Client 经 ExAxios 直接返回成功数据，失败抛出 `ExAxiosError`，身份页面按其状态码和错误码决定重试、重新开始或拒绝无效入口。身份路由中的会话失效由当前页面继续处理；共享请求层同步浏览器会话后不把该路由跳到普通 `/login`，以保留 challenge 和退出确认流程。

`/identity/signed-out` 重新验证当前 token，只删除已确认无效且仍匹配的 token；请求代次与会话变化订阅使迟到退出检查不能清除后来登录的新账号。该页只提供首页返回，不读取旧 Docs return/resume 参数或自动导航。服务端撤销仍是会话有效性的依据。跨服务边界见 `.ai/architectures/identity/integration-boundaries.md`。

## 用户设置

登录用户菜单的“设置”和“个人资料”打开同一 Modal，分别默认选中通用和个人资料；`/account/profile` 以页面容器复用相同主体。共享界面负责分类、单项表单和头像裁剪；`apps/web/src/settings/` 负责经生成 Client 请求本人资料。通用分类的主题由 ExUI `ThemeProvider` 决定，Valtio 中的值只是读取投影。

设置资料只缓存在内存，按当前 token 归属并用请求代次拒绝迟到结果。重新打开会刷新，明确失效或账号切换会清空。保存成功先采用服务器返回的完整本人资料，再调用既有 `AuthContext.refreshProfile()` 同步顶栏；顶栏刷新失败不会回滚已经保存的设置。退出仍交给 `AuthContext.logout()`。设置状态与认证状态的职责依据见 `.ai/decisions/web/04-settings-state-separate-from-auth-context.md`。

关联账户分区由 `apps/web/src/settings/IdentityLinksExperience.tsx` 独立读取，不受本人资料或通知偏好错误阻断。它按 provider 将服务器列表投影为共享 `IdentityLinksPanel` 的条目和动作配置；共享组件只展示，Cfx 授权由 Web 注入，Google、QQ 仍禁用。已有当前关联不静默替换；Cfx disabled 仍展示和允许确认解绑。社区影响按 provider 保存，只统计已加入且 `requiredProviders` 匹配该 provider 的社区；可解绑项在读取未完成或失败时明示影响未知，当前 Cfx 分区提供重试，解绑不删除成员资格。关联 POST 或解绑 DELETE 后都 GET 本人关联核实，即使写请求报错也用重读判断结果；重读未确认时锁定同一 provider 的重复操作并提供显式重读，不盲目重用 ticket。token owner 变化使旧分区及请求代次失效，AbortSignal 与捕获的 owner 防止迟到结果覆盖新账户。

## SSO 接收流程

SSO 页先检查请求，再尝试用已有本站 token 确认；失效 token 被清除后显示密码表单，网络或服务错误保留 token 并提供重试。密码确认使用独立 SSO operation，不把返回值写入 `localStorage`。

服务端确认完成后，当前标签页才把 `{ssoRequestId, confirmedAt}` 写入 `sessionStorage` 的 `exwebsite.auth.sso-success`，再整页替换到 `/sso/success`。成功页只接受五分钟内的当前标签页记录；该记录只控制提示，不是授权凭据。

成功页复用登录页的品牌 Icon 和外围 Glass 卡片。有效成功记录时提示“登录成功”“正在返回应用”，五秒后尝试关闭当前页面；浏览器可能拒绝脚本关闭非脚本打开的标签页，此时提示用户手动关闭。缺少有效记录时在同一卡片内直接显示居中的“发生错误”标题与原因，不叠加错误 Alert 的 Glass，并提供左上角 Home 入口；此时不启动关闭计时。
