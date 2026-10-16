const details = {
  REGISTRATION_CODE_INVALID: [400, '验证码无效或已过期。'],
  REGISTRATION_CODE_LOCKED: [429, '验证码错误次数过多，请稍后重试。'],
  REGISTRATION_CODE_RESEND_TOO_SOON: [429, '验证码发送过于频繁，请稍后重试。'],
  REGISTRATION_GRANT_INVALID: [410, '注册凭证无效或已过期。'],
  REGISTRATION_IN_PROGRESS: [409, '注册正在处理中，请稍后查询结果。'],
  REGISTRATION_RESTART_REQUIRED: [410, '请重新验证邮箱或授权。'],
  REGISTRATION_CAPACITY_EXCEEDED: [503, '注册服务繁忙，请稍后重试。'],
  REGISTRATION_MAIL_UNAVAILABLE: [503, '注册邮件服务暂不可用。'],
} as const
export class RegistrationError extends Error {
  readonly statusCode: number
  readonly publicMessage: string
  readonly retryAfterSeconds?: number
  constructor(
    readonly code: keyof typeof details,
    retryAfterSeconds?: number,
  ) {
    super(code)
    this.statusCode = details[code][0]
    this.publicMessage = details[code][1]
    this.retryAfterSeconds = retryAfterSeconds ?? (this.statusCode === 503 ? 60 : undefined)
  }
}
