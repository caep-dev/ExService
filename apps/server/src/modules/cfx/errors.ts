const definitions = {
  CFX_DISABLED: [503, 'Cfx identity verification is disabled.'],
  CFX_FLOW_UNAVAILABLE: [403, 'This Cfx authorization flow is unavailable.'],
  CFX_ORIGIN_FORBIDDEN: [403, 'This request origin is not allowed.'],
  CFX_ATTEMPT_NOT_FOUND: [404, 'Cfx authorization attempt was not found.'],
  CFX_ATTEMPT_EXPIRED: [410, 'Cfx authorization attempt has expired.'],
  CFX_ATTEMPT_CONFLICT: [409, 'Cfx authorization attempt cannot be completed.'],
  CFX_INVALID_PAYLOAD: [400, 'Cfx authorization payload is invalid.'],
  CFX_NONCE_INVALID: [400, 'Cfx authorization nonce is invalid.'],
  CFX_API_VERSION_UNSUPPORTED: [400, 'Cfx authorization API version is unsupported.'],
  CFX_USER_INVALID: [502, 'Cfx user information is invalid.'],
  CFX_EMAIL_UNAVAILABLE: [502, 'Cfx email information is unavailable.'],
  CFX_UPSTREAM_UNAVAILABLE: [502, 'Cfx identity service is unavailable.'],
  CFX_UPSTREAM_TIMEOUT: [504, 'Cfx identity service timed out.'],
  CFX_REQUEST_LIMITED: [429, 'Too many Cfx identity requests.'],
  CFX_CAPACITY_EXCEEDED: [503, 'Cfx identity verification capacity is exhausted.'],
  CFX_SERVICE_CLOSED: [503, 'Cfx identity service is closed.'],
  CFX_IDENTITY_TICKET_INVALID: [409, 'Cfx identity ticket is invalid.'],
  CFX_IDENTITY_TICKET_EXPIRED: [410, 'Cfx identity ticket has expired.'],
} as const
export type CfxErrorCode = keyof typeof definitions
export class CfxError extends Error {
  readonly statusCode: number
  readonly publicMessage: string
  readonly retryAfterSeconds?: number
  constructor(readonly code: CfxErrorCode, retryAfterSeconds?: number) {
    super(definitions[code][1]); this.statusCode = definitions[code][0]; this.publicMessage = definitions[code][1]
    this.retryAfterSeconds = retryAfterSeconds ?? (this.statusCode === 503 ? 60 : undefined)
  }
}
