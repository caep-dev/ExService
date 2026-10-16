import type { components } from '@workspace/api-client/types'
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { AuthError } from '@server/src/modules/auth/errors.js'
import { authenticateBearer } from '../../../modules/auth/api/security.js'
import type { MultipartWireErrors } from '@server/src/http/shared/multipart-counter.js'
import {
  createMultipartUploadRegistry,
  declaredResponseStatuses,
  type MultipartParseResult,
  type MultipartUploadLimits,
  type MultipartUploadScope,
} from '@server/src/http/shared/multipart-upload-lifecycle.js'
import { normalizeJoinApplicationPayload } from '@server/src/domains/join/applications/form-validation.js'
import type { JoinProofInput } from '@server/src/domains/join/applications/attachment-validation.js'

/** Schema body after wire parsing; binary proofs live in the trusted parser context. */
export type JoinTransportBody = components['schemas']['JoinApplicationRequest']
export interface ParsedJoinUpload {
  application: components['schemas']['JoinApplicationPayload']
  proofs: JoinProofInput[]
}

interface UploadLimits extends MultipartUploadLimits {
  wireBytes: number
  jsonBytes: number
  fileBytes: number
  totalFileBytes: number
  proofs: number
  parts: number
  fieldNameBytes: number
  headerPairs: number
  headerBytes: number
  slots: number
  deadlineMs: number
}

/** 受控 wire 计数器按 join 的错误分类抛错：413 超限、415 非 multipart、400 结构非法。 */
const JOIN_WIRE_ERRORS: MultipartWireErrors = {
  tooLarge: () => new AuthError('JOIN_UPLOAD_TOO_LARGE'),
  malformed: () => new AuthError('BAD_REQUEST'),
  unsupportedMediaType: () => new AuthError('JOIN_UNSUPPORTED_MEDIA_TYPE'),
}
interface DownloadLimits {
  slots: number
  deadlineMs: number
}

/**
 * 加入申请的上传生命周期注册表。
 *
 * 连接时序（raw 适配、流接入、deadline、abort、buffer 与单次槽位释放）由共用 module 拥有；
 * 这里只保留配置核验、前置限流、payload 规则、错误分类与可信 getter。
 * controller 按 transport 注册创建，容量因此归该 Fastify 实例私有。
 */
const joinUploads = createMultipartUploadRegistry<ParsedJoinUpload>()

/** Buffers never enter the JSON schema body. Nonempty markers require the trusted parser context. */
export function getJoinProofs(request: FastifyRequest): JoinProofInput[] {
  const proofs = (request.body as { proofs?: unknown } | undefined)?.proofs
  if (!Array.isArray(proofs) || proofs.some((value) => typeof value !== 'string'))
    throw new AuthError('BAD_REQUEST')
  const parsed = joinUploads.getParsed(request)
  if (parsed === undefined) {
    // 直接 handler 调用没有解析上下文；此时只允许空的 proofs 标记。
    if (proofs.length !== 0) throw new AuthError('BAD_REQUEST')
    return []
  }
  if (
    proofs.length !== parsed.proofs.length ||
    proofs.some((value, i) => value !== `join-proof-${i}`)
  )
    throw new AuthError('BAD_REQUEST')
  return parsed.proofs
}

function config<T extends object>(value: unknown, keys: readonly string[]): T {
  if (value === null || typeof value !== 'object')
    throw new Error('Missing join transport limits in API contract.')
  const limits = value as Record<string, unknown>
  for (const key of keys) {
    if (
      typeof limits[key] !== 'number' ||
      !Number.isSafeInteger(limits[key]) ||
      (limits[key] as number) < 1
    ) {
      throw new Error(`Invalid join transport limit: ${key}`)
    }
  }
  return value as T
}

function appendHook<
  K extends 'onRequest' | 'preValidation' | 'onResponse' | 'onError' | 'onRequestAbort',
>(route: RouteOptions, key: K, hook: NonNullable<RouteOptions[K]>): void {
  const previous = route[key]
  // Each stage keeps existing Glue/consumer hooks in their declared order.
  Object.assign(route, {
    [key]: [
      ...(previous === undefined ? [] : Array.isArray(previous) ? previous : [previous]),
      hook,
    ],
  })
}

/** 恰好一个 application JSON 文件与至多 proofs 个附件；未知字段与非文件 part 一律拒绝。 */
async function parseJoinUpload(
  _request: FastifyRequest,
  scope: MultipartUploadScope,
  budget: UploadLimits,
): Promise<MultipartParseResult<ParsedJoinUpload>> {
  let application: unknown
  let seenApplication = false
  let total = 0
  let count = 0
  const proofs: JoinProofInput[] = []
  for await (const part of scope.parts({
    parts: budget.parts,
    files: budget.parts,
    fields: budget.parts,
    fieldSize: budget.jsonBytes,
    fileSize: Math.max(budget.fileBytes, budget.jsonBytes),
    fieldNameSize: budget.fieldNameBytes,
    headerPairs: budget.headerPairs,
    headerSize: budget.headerBytes,
  })) {
    // 字段名按 UTF-8 字节数显式复核，不能只信任 busboy 的 fieldNameSize。
    if (Buffer.byteLength(part.fieldname, 'utf8') > budget.fieldNameBytes)
      throw new AuthError('JOIN_UPLOAD_TOO_LARGE')
    if (part.type !== 'file') throw new AuthError('BAD_REQUEST')
    if (part.fieldname !== 'application' && part.fieldname !== 'proofs')
      throw new AuthError('BAD_REQUEST')
    const json = part.fieldname === 'application'
    if (json && (seenApplication || part.mimetype !== 'application/json')) {
      throw new AuthError(seenApplication ? 'BAD_REQUEST' : 'JOIN_UNSUPPORTED_MEDIA_TYPE')
    }
    if (json) seenApplication = true
    if (!json && ++count > budget.proofs) throw new AuthError('JOIN_UPLOAD_TOO_LARGE')
    // 附件同时受单文件上限与剩余总量上限约束。
    const maxBytes = json
      ? budget.jsonBytes
      : Math.min(budget.fileBytes, budget.totalFileBytes - total)
    const buffer = await scope.readFile(part.file, maxBytes)
    if (json) {
      try {
        application = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
      } catch {
        throw new AuthError('BAD_REQUEST')
      }
    } else {
      total += buffer.length
      if (total > budget.totalFileBytes) throw new AuthError('JOIN_UPLOAD_TOO_LARGE')
      proofs.push({ originalName: part.filename, bytes: buffer })
    }
  }
  if (!seenApplication) throw new AuthError('BAD_REQUEST')
  // 归一化结果仍由 Contract validator 复核；此处只按既有信任边界转成 schema 形状。
  const normalized = normalizeJoinApplicationPayload(
    application,
  ) as components['schemas']['JoinApplicationPayload']
  return {
    body: {
      application: normalized,
      proofs: proofs.map((_, i) => `join-proof-${i}`),
    },
    value: { application: normalized, proofs },
  }
}

function classify(error: unknown): Error {
  if (error instanceof AuthError) return error
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === 413
  ) {
    return new AuthError('JOIN_UPLOAD_TOO_LARGE')
  }
  return new AuthError('BAD_REQUEST')
}

export function registerJoinTransport(app: FastifyInstance): void {
  let activeDownloads = 0
  // 每次注册建一个 controller：槽位属于这个 Fastify 实例，不与其他实例共享。
  const joinUpload = joinUploads.create(app)
  app.addHook('onRoute', (route) => {
    const operationId = (route.schema as { operationId?: string } | undefined)?.operationId
    if (operationId === 'submitJoinApplication') {
      const budget = config<UploadLimits>((route.config as { joinUpload?: unknown }).joinUpload, [
        'wireBytes',
        'jsonBytes',
        'fileBytes',
        'totalFileBytes',
        'proofs',
        'parts',
        'fieldNameBytes',
        'headerPairs',
        'headerBytes',
        'slots',
        'deadlineMs',
      ])
      if (
        budget.parts !== budget.proofs + 1 ||
        budget.totalFileBytes > budget.proofs * budget.fileBytes ||
        budget.jsonBytes > budget.wireBytes
      )
        throw new Error('Inconsistent join upload limits.')
      joinUpload.attach(route, {
        // `budget` 是 route config 的活动对象：deadline 等限额在每请求读取，
        // 测试对 route config 的覆盖仍然生效，注册时不冻结第二份常量。
        limits: budget,
        declaredStatuses: declaredResponseStatuses(route),
        errors: JOIN_WIRE_ERRORS,
        // 限流先于占位与任何请求体消费。
        admit: async (request) => {
          await authenticateBearer(request, request.server.authServices)
          request.server.joinServices.limit(request.ip)
        },
        parse: (request, scope) => parseJoinUpload(request, scope, budget),
        classify,
        timedOut: () => new AuthError('JOIN_UPLOAD_TIMEOUT'),
        busy: () => new AuthError('JOIN_UPLOAD_BUSY', { retryAfterSeconds: 5 }),
      })
    } else if (operationId === 'downloadJoinApplicationAttachment') {
      const limits = config<DownloadLimits>(
        (route.config as { joinDownload?: unknown }).joinDownload,
        ['slots', 'deadlineMs'],
      )
      const releases = new WeakMap<FastifyRequest, () => void>()
      appendHook(route, 'onRequest', async (request: FastifyRequest, reply) => {
        void reply.header('Cache-Control', 'no-store')
        if (activeDownloads >= limits.slots)
          throw new AuthError('JOIN_DOWNLOAD_BUSY', { retryAfterSeconds: 5 })
        activeDownloads++
        let released = false
        const release = () => {
          if (!released) {
            released = true
            clearTimeout(timer)
            activeDownloads--
            reply.raw.removeListener('close', release)
          }
        }
        const timer = setTimeout(() => {
          reply.raw.destroy()
          release()
        }, limits.deadlineMs)
        timer.unref()
        reply.raw.once('close', release)
        releases.set(request, release)
      })
      appendHook(route, 'onResponse', async (request) => {
        releases.get(request)?.()
        releases.delete(request)
      })
      appendHook(route, 'onError', async (request) => {
        releases.get(request)?.()
        releases.delete(request)
      })
      appendHook(route, 'onRequestAbort', async (request) => {
        releases.get(request)?.()
        releases.delete(request)
      })
    }
  })
}
