# 账户 UUID、第三方关联与社区申请归属

- 状态：已接受，schema 与 0006 migration 已定义；已有数据库切换仍须显式执行。
- 模块：账户、第三方身份、社区及加入申请。
- 日期：2026-10-12。
- 依据：已确认的 `.notes/public-registration/specs/2026-10-12-public-registration-and-community-membership-design.md`。
- 实施依据：`.notes/public-registration/rfcs/public-registration-and-community-membership-rfc.md`。

## 当前事实

`auth_users` 保留独立 UUID、唯一邮箱和必填密码哈希。当前 schema 为 `join_applications` 定义申请人 UUID 与社区归属；原匿名记录只读保留。`community_groups` 继续表达平台身份分组，与社区成员资格分开。

表职责由 `.ai/databases/data-model.md` 说明，物理结构以 `apps/server/src/db/schema.ts` 和 `apps/server/drizzle/` 为准。下列约束用于当前源码，不代表既有数据库已完成迁移。

## 标识与关联决策

- 新 Exre 账户生成一次永久 UUID，既有账户保持原 ID；第三方关联或解除关联不重新生成账户 ID。
- 邮箱保持规范化唯一，用于登录和查重，不作为申请、成员资格或其他业务关系的主键。沿用 trim 和 lowercase，不额外折叠邮箱的点号或加号。
- 第三方关系通过稳定外部身份关联 Exre UUID。每个平台每个 Exre 账户最多一条当前关联，同一外部身份同时只能关联一个 Exre 账户；平台和外部用户 ID 一起标识外部身份。
- 解除关联移除当前关系，不永久占用外部身份；历史申请的展示快照保留，不以可删除的当前关联关系承载成员资格。
- 服务器社区、社区审核授权和社区成员资格使用独立关系；既有 `community_groups` 继续承担身份分组职责。

## 申请与资格决策

- 新申请必须关联已登录的 `userId` 和指定 `communityId`，由真实会话确定申请人；邮箱、名字及外部资料只作为提交时快照。
- 唯一规则覆盖 `userId + communityId` 的全部状态。pending、approved、rejected 均持续占用机会，提交失败不占用，解绑或更换外部身份不清空记录。一个账户仍可申请其他社区。
- Cfx 不参与申请去重。另一个 Exre UUID 即使使用相同 Cfx 身份，也按另一个申请人处理；有效关联本身仍须满足前述同时唯一约束。
- approved 申请产生对应账户和社区的成员资格，资格关联真实获批申请，不关联当前 Cfx 行。解除或更换 Cfx 保留成员关系。
- 审核事实、通过时的成员关系和结果通知业务事件在同一事务提交；异步通知投影失败不撤销已提交决定。

注册验证方式、关联操作及社区要求的业务语义集中于 `.ai/decisions/auth/01-public-registration-and-community-access.md`。

## 历史与迁移决策

- 保留原账户 UUID、密码、会话身份关系、头像、申请、表单、附件、邀请和投递事实，不通过 reset 切换新模型。
- 只有已完成邀请中明确指向真实账户、对应申请确已通过的关系，才可用于迁移该账户的历史社区申请和成员资格；不能只按相同邮箱或名字自动认领。
- 无可信账户归属的旧匿名申请保留只读，不自动挂到新注册账户，也不占用未建立关系的 UUID 的一次申请机会。旧记录由对应社区的受控审核范围读取。
- 切换后旧邀请及完善凭证不能继续授权建号，原历史事实仍保留。可归属历史发生重复或损坏时阻止迁移，不静默删除或选择一条记录掩盖冲突。

迁移仅由显式命令执行，沿用 `.ai/databases/decisions/03-database-changes-only-by-explicit-command.md`。迁移事务内重新核验可信历史关系与冲突，之前的只读盘点不能代替复核；结构定义、显式升级与实际环境验收分别表达。
