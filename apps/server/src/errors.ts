import type { FastifyError, FastifyInstance } from 'fastify'
import { AuthError, type AuthErrorCode } from '@server/src/modules/auth/errors.js'
import type { StorageErrorCode } from '@server/src/modules/storage/errors.js'
import type { FeedbackErrorCode } from './domains/support/errors.js'
import type { CfxErrorCode } from './modules/cfx/errors.js'

/**
 * Contract 只把 `ErrorEnvelope.error.code` 约束为 string；下列取值是实现侧的约定。
 * 新增取值不需要改 Contract，但必须集中在本文件构造 envelope，并保持 Contract Test 通过。
 */
export type ErrorCode = 'BAD_REQUEST' | 'INTERNAL_ERROR' | 'NOT_FOUND' | AuthErrorCode | StorageErrorCode | FeedbackErrorCode | CfxErrorCode

/**
 * 应用错误对外契约：带 code / statusCode / publicMessage 的错误都按固定文案输出，
 * 其余异常的 `error.message` 一律不回显。
 *
 * 这里用结构化判定而不是 `instanceof`，因此新增错误类型不需要把模块 import 进来。
 */
interface PublicError {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly publicMessage: string
  readonly retryAfterSeconds?: number
}

function asPublicError(value: unknown): PublicError | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.code !== 'string') return undefined
  if (typeof candidate.statusCode !== 'number') return undefined
  if (typeof candidate.publicMessage !== 'string') return undefined
  return candidate as unknown as PublicError
}

export function createErrorEnvelope(code: ErrorCode, message: string, requestId: string) {
  return { error: { code, message, requestId } }
}

/** 未声明路径的 404 文案；正常错误链与提前终结适配共用同一常量。 */
export const NOT_FOUND_MESSAGE = 'The requested route is not part of the API contract.'

function codeForStatus(statusCode: number): ErrorCode {
  if (statusCode === 404) {
    return 'NOT_FOUND'
  }
  return statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'
}

/** `request.log` 的安全子集：只接受结构化字段与固定文案，不回显原始异常。 */
export interface SafeErrorLog {
  warn(fields: { code: ErrorCode; statusCode: number }, message: string): void
  error(fields: { code: ErrorCode; statusCode: number }, message: string): void
}

export interface ErrorResolution {
  statusCode: number
  code: ErrorCode
  message: string
  retryAfterSeconds?: number
  /** 精确符合 Contract ErrorEnvelope 的对象；不得追加 cause、stack 或其他字段。 */
  envelope: { error: { code: ErrorCode; message: string; requestId: string } }
}

/**
 * 既有安全映射的唯一实现：正常错误链与 multipart 上传的提前终结适配共用它。
 *
 * 提取的功能面是全部 operation 的错误响应，不只是两条上传，因此任何改动都必须先通过
 * 非上传错误 envelope 的逐字节回归。日志等级与字段（`request failed` / `request rejected`）
 * 一并属于本函数的契约，调用方不得自行再记一份。
 */
export function resolveErrorResponse(error: unknown, log: SafeErrorLog, requestId: string): ErrorResolution {
  const publicError = findPublicError(error)
  const reportedStatus = (error as { statusCode?: unknown } | null | undefined)?.statusCode
  const reported = publicError?.statusCode ?? (typeof reportedStatus === 'number' ? reportedStatus : 500)
  const statusCode = reported >= 400 && reported < 600 ? reported : 500

  const message = publicError?.publicMessage ?? resolvePublicMessage(statusCode, error as FastifyError)
  const code = publicError?.code ?? codeForStatus(statusCode)

  // Exceptions from hashing, delivery or PostgreSQL can contain submitted secrets.
  // Request ID remains attached by Fastify; log only the safe classification.
  if (statusCode >= 500) {
    log.error({ code, statusCode }, 'request failed')
  } else {
    log.warn({ code, statusCode }, 'request rejected')
  }

  return {
    statusCode,
    code,
    message,
    ...(publicError?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: publicError.retryAfterSeconds }),
    envelope: createErrorEnvelope(code, message, requestId),
  }
}

/**
 * 统一错误输出：未声明路径与所有未捕获错误都返回 Contract 中的 ErrorEnvelope。
 *
 * 对外消息只允许两种来源：
 * 1. Fastify 依据 Contract schema 生成的校验错误（`error.validation`），对调用方有价值且不含内部状态；
 * 2. 固定文案。
 *
 * 其他异常（包括应用代码主动抛出的 4xx）一律不回显 `error.message`：
 * 它可能包含 SQL、数据库连接信息、堆栈或原始异常内容。
 * Fastify request ID 同时用于响应中的 `requestId` 与日志关联。
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .header('Cache-Control', 'no-store')
      .status(404)
      .send(createErrorEnvelope('NOT_FOUND', NOT_FOUND_MESSAGE, request.id))
  })

  // Fastify 5 的 setErrorHandler 默认把错误参数推断为 unknown，因此显式声明 FastifyError。
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const resolution = resolveErrorResponse(error, request.log, request.id)

    void reply.header('Cache-Control', 'no-store')
    if (resolution.retryAfterSeconds !== undefined) {
      void reply.header('Retry-After', String(resolution.retryAfterSeconds))
    }
    void reply.status(resolution.statusCode).send(resolution.envelope)
  })
}

function findPublicError(error: unknown): PublicError | undefined {
  if (error instanceof AuthError) {
    return error
  }
  const direct = asPublicError(error)
  if (direct !== undefined) {
    return direct
  }
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const nested = (error as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      for (const candidate of nested) {
        const publicError = findPublicError(candidate)
        if (publicError !== undefined) {
          return publicError
        }
      }
    }
  }
  return undefined
}

function resolvePublicMessage(statusCode: number, error: FastifyError): string {
  if (statusCode >= 500) {
    return 'An unexpected error occurred.'
  }

  // 只有 Fastify 自己的校验错误可以回显：它由 Contract schema 产生，不携带内部实现细节。
  if (error.validation !== undefined) {
    return error.message
  }

  return 'The request could not be processed.'
}
