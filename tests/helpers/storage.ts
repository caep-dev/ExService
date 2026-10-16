import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { FastifyInstance } from '../../apps/server/node_modules/fastify'
import { createApp } from '@workspace/server'
import { createStorageModule, type StorageServices } from '@server/src/modules/storage/factory'
import { parseStorageConfig, type StorageConfig } from '@server/src/modules/storage/config'
import type { CosDependencies, CosTemporaryCredentials } from '@server/src/modules/storage/adapters/cos'
import type { TestAuth } from './auth'

/** 严格 64 位十六进制，满足 STORAGE_UPLOAD_HMAC_KEY 的格式要求。 */
export const TEST_HMAC_KEY = 'a1b2c3d4'.repeat(8)

export const TEST_BUCKET = 'exre-test-1250000000'
export const TEST_REGION = 'ap-guangzhou'

export interface StoredCosObject {
  bytes: Uint8Array
  contentType: string
  contentDisposition: string
  cacheControl: string
  contentLength: number | undefined
}

export interface FakeCos extends CosDependencies {
  objects: Map<string, StoredCosObject>
  calls: {
    putObject: Array<{ key: string; contentType: string; byteLength: number; contentLength: number | undefined; contentDisposition: string; cacheControl: string }>
    headObject: string[]
    signDownloadUrl: Array<{ key: string }>
    issueCredentials: Array<{ key: string }>
  }
  /** 记录 STS policy，用于断言精确权限。 */
  policies: Array<Record<string, unknown>>
  /** 让指定操作抛错，用于故障注入与失败传播测试。 */
  fail: { putObject?: unknown; headObject?: unknown; issueCredentials?: unknown }
}

export function createFakeCos(bucket = TEST_BUCKET, region = TEST_REGION): FakeCos {
  const objects = new Map<string, StoredCosObject>()
  const fake: FakeCos = {
    objects,
    calls: { putObject: [], headObject: [], signDownloadUrl: [], issueCredentials: [] },
    policies: [],
    fail: {},
    async putObject({ key, bytes, contentType }) {
      if (fake.fail.putObject !== undefined) throw fake.fail.putObject
      fake.calls.putObject.push({ key, contentType, byteLength: bytes.byteLength, contentLength: bytes.byteLength, contentDisposition: 'attachment', cacheControl: 'no-store' })
      objects.set(key, {
        bytes: new Uint8Array(bytes),
        contentType,
        contentDisposition: 'attachment',
        cacheControl: 'no-store',
        contentLength: bytes.byteLength,
      })
    },
    async headObject({ key }) {
      if (fake.fail.headObject !== undefined) throw fake.fail.headObject
      fake.calls.headObject.push(key)
      const object = objects.get(key)
      if (object === undefined) throw Object.assign(new Error('NoSuchKey'), { statusCode: 404, code: 'NoSuchKey' })
      return { bytes: object.bytes.byteLength }
    },
    signDownloadUrl({ key }) {
      fake.calls.signDownloadUrl.push({ key })
      // 形态与真实 COS 一致：标准域名、https、签名参数，并把 disposition 纳入签名。
      return `https://${bucket}.cos.${region}.myqcloud.com/${key}?q-sign-time=1;2&response-content-disposition=attachment&q-signature=test`
    },
    async issueCredentials({ key }) {
      if (fake.fail.issueCredentials !== undefined) throw fake.fail.issueCredentials
      fake.calls.issueCredentials.push({ key })
      const credentials: CosTemporaryCredentials = {
        tmpSecretId: 'tmp-id',
        tmpSecretKey: 'tmp-key',
        securityToken: 'tmp-token',
        startTime: 1_800_000_000,
        expiredTime: 1_800_000_000 + 1800,
      }
      return credentials
    },
  }
  return fake
}

export function storageConfig(env: NodeJS.ProcessEnv, dataRoot: string): StorageConfig {
  return parseStorageConfig(env, { dataRoot })
}

export interface StorageTestFixture {
  dataRoot: string
  storage: StorageServices
  cleanup: () => void
}

/** 本地介质：临时目录，不写开发 data。 */
export function fileStorageFixture(env: NodeJS.ProcessEnv = {}): StorageTestFixture {
  const dataRoot = mkdtempSync(resolve(tmpdir(), 'exwebsite-storage-file-'))
  return {
    dataRoot,
    storage: createStorageModule({ config: storageConfig(env, dataRoot) }),
    cleanup: () => rmSync(dataRoot, { recursive: true, force: true }),
  }
}

/** COS 介质：启用 cos 默认介质并注入 fake 云端依赖。 */
export function cosStorageFixture(cos: FakeCos, env: NodeJS.ProcessEnv = {}): StorageTestFixture {
  const dataRoot = mkdtempSync(resolve(tmpdir(), 'exwebsite-storage-cos-'))
  const config = storageConfig({
    STORAGE_DEFAULT_ADAPTER: 'cos',
    STORAGE_MAX_BYTES: '1024',
    STORAGE_UPLOAD_HMAC_KEY: TEST_HMAC_KEY,
    TENCENT_COS_SECRET_ID: 'test-secret-id',
    TENCENT_COS_SECRET_KEY: 'test-secret-key',
    TENCENT_COS_REGION: TEST_REGION,
    TENCENT_COS_BUCKET: TEST_BUCKET,
    ...env,
  }, dataRoot)
  return {
    dataRoot,
    storage: createStorageModule({ config, cosDependencies: cos }),
    cleanup: () => rmSync(dataRoot, { recursive: true, force: true }),
  }
}

/** 用指定存储服务组装真实 app，其余依赖沿用既有测试 fixture。 */
export function createAppWithStorage(fixture: TestAuth, storage: StorageServices): FastifyInstance {
  return createApp({
    ...fixture,
    storageServices: storage,
    notifications: fixture.notifications, clickupServices: fixture.clickupServices, supportServices: fixture.supportServices,
  })
}

/** 构造 multipart 请求体的最小辅助：不手写 Content-Type boundary，交给 FormData。 */
export function uploadForm(fields: Record<string, string>, file: { name: string; bytes: Uint8Array; type?: string }): FormData {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  form.append('data', new Blob([Uint8Array.from(file.bytes)], { type: file.type ?? 'application/octet-stream' }), file.name)
  return form
}
