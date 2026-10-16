export class IdentityLinkError extends Error {
  readonly statusCode: number
  readonly publicMessage: string
  readonly retryAfterSeconds?: number
  constructor(
    readonly code:
      | 'IDENTITY_LINK_CONFLICT'
      | 'IDENTITY_LINK_ATTEMPT_INVALID'
      | 'REGISTRATION_CAPACITY_EXCEEDED',
  ) {
    super(code)
    this.statusCode =
      code === 'REGISTRATION_CAPACITY_EXCEEDED' ? 503 : code === 'IDENTITY_LINK_CONFLICT' ? 409 : 410
    if (this.statusCode === 503) this.retryAfterSeconds = 60
    this.publicMessage =
      code === 'REGISTRATION_CAPACITY_EXCEEDED'
        ? '关联服务繁忙，请稍后重试。'
        : code === 'IDENTITY_LINK_CONFLICT'
          ? '第三方关联冲突，请先解除已有关联。'
          : '关联授权无效，请重新授权。'
  }
}
