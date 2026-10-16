import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppDatabase, SqlExecutor } from '@server/src/db/client.js'
import sharp from 'sharp'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_PIXELS = 16_000_000
const MAX_SIDE = 8192
const AVATAR_ID = /^[A-Za-z0-9_-]{43}$/
const FORMATS = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
} as const

/** `src/modules/profile` 与 `dist/modules/profile` 的相对层级相同。Server 只使用这一固定目录。 */
export const AVATAR_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/avatars')
export const PUBLIC_AVATAR_BASE_URL = 'http://127.0.0.1:8080/api/avatars'

export function avatarDirectory(configured: string | undefined): string {
  if (configured === undefined || configured === '') return AVATAR_DIRECTORY
  if (!configured.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(configured)) {
    throw new Error('SERVER_AVATAR_DIRECTORY 必须是绝对路径。')
  }
  return resolve(configured)
}

export function publicAvatarBaseUrl(configured: string | undefined): string {
  if (configured === undefined || configured === '') return PUBLIC_AVATAR_BASE_URL
  const url = new URL(configured)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith('/api/avatars')) {
    throw new Error('SERVER_PUBLIC_AVATAR_BASE_URL 必须是指向 /api/avatars 的公开 HTTP(S) 地址。')
  }
  return url.href.replace(/\/$/, '')
}

interface UserProfileRow {
  id: string
  email: string
  nickname: string
  qq: string | null
  fivem_id: string | null
  avatar_key: string | null
}

export interface ProfileUpdate {
  nickname?: string
  qq?: string | null
  fivemId?: string | null
  avatar?: null
}

export interface AvatarUpload {
  imageBase64: string
  mediaType: keyof typeof FORMATS
}

export class ProfileError extends Error {
  constructor(readonly statusCode: 400 | 404 | 413) {
    super('Profile request rejected')
  }
}

export class ProfileService {
  constructor(
    private readonly db: AppDatabase,
    private readonly avatarDirectory = AVATAR_DIRECTORY,
    private readonly publicAvatarBaseUrl = PUBLIC_AVATAR_BASE_URL,
  ) {}

  async snapshot(userId: string) {
    const row = await this.readUser(userId)
    return this.toSnapshot(row)
  }

  async update(userId: string, input: ProfileUpdate, assertSessionCurrent: (tx: SqlExecutor) => Promise<void>) {
    const result = await this.db.transaction(async tx => {
      const row = await this.readUser(userId, tx, true)
      await assertSessionCurrent(tx)
      const assignments: string[] = []
      const values: Array<string | null> = []
      if (input.nickname !== undefined) {
        const nickname = input.nickname.trim()
        if (Array.from(nickname).length < 1 || Array.from(nickname).length > 32 ||
          /[\u0000-\u001F\u007F-\u009F]/u.test(nickname)) {
          throw new ProfileError(400)
        }
        assignments.push(`nickname = $${values.length + 1}`)
        values.push(nickname)
      }
      if (input.qq !== undefined) {
        if (input.qq !== null && !/^[0-9]{1,20}$/.test(input.qq)) throw new ProfileError(400)
        assignments.push(`qq = $${values.length + 1}`)
        values.push(input.qq)
      }
      if (input.fivemId !== undefined) {
        if (input.fivemId !== null && (input.fivemId.length > 64 || !/^fivem:[0-9]+$/.test(input.fivemId))) {
          throw new ProfileError(400)
        }
        assignments.push(`fivem_id = $${values.length + 1}`)
        values.push(input.fivemId)
      }
      if (input.avatar === null) {
        assignments.push('avatar_key = NULL')
      }
      if ((input.nickname !== undefined && input.nickname.trim() !== row.nickname) ||
          (input.avatar === null && row.avatar_key !== null)) {
        assignments.push('profile_version = profile_version + 1')
      }
      if (assignments.length > 0) {
        const update = await tx.query(`UPDATE auth_users SET ${assignments.join(', ')} WHERE id = $${values.length + 1}`,
          [...values, userId])
        if (update.rowCount !== 1) throw new ProfileError(404)
      }
      return { previousAvatar: input.avatar === null ? row.avatar_key : null,
        snapshot: this.toSnapshot(await this.readUser(userId, tx)) }
    })
    if (result.previousAvatar !== null) {
      await this.removeUnreferencedAvatar(result.previousAvatar)
    }
    return result.snapshot
  }

  async upload(userId: string, input: AvatarUpload, assertSessionCurrent: (tx: SqlExecutor) => Promise<void>) {
    const bytes = decodeImage(input.imageBase64)
    const expectedFormat = FORMATS[input.mediaType]
    if (expectedFormat === undefined) {
      throw new ProfileError(400)
    }
    let output: Buffer
    try {
      const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS })
      const metadata = await image.metadata()
      if (metadata.format !== expectedFormat || metadata.width === undefined || metadata.height === undefined ||
        metadata.width > MAX_SIDE || metadata.height > MAX_SIDE ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) {
        throw new ProfileError(400)
      }
      output = await image.rotate().resize(512, 512, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 }).toBuffer()
    } catch (error) {
      if (error instanceof ProfileError) throw error
      throw new ProfileError(400)
    }
    if (output.length > MAX_OUTPUT_BYTES) {
      throw new ProfileError(400)
    }

    const avatarId = randomBytes(32).toString('base64url')
    const finalPath = resolve(this.avatarDirectory, `${avatarId}.webp`)
    const temporaryPath = resolve(this.avatarDirectory, `${avatarId}.tmp`)
    await mkdir(this.avatarDirectory, { recursive: true })
    let temporaryCreated = false
    try {
      await writeFile(temporaryPath, output, { flag: 'wx' })
      temporaryCreated = true
      await rename(temporaryPath, finalPath)
    } catch (error) {
      if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined)
      throw error
    }

    let previousAvatar: string | null
    let snapshot: Awaited<ReturnType<ProfileService['snapshot']>>
    try {
      const result = await this.db.transaction(async tx => {
        const row = await this.readUser(userId, tx, true)
        await assertSessionCurrent(tx)
        const update = await tx.query('UPDATE auth_users SET avatar_key = $1, profile_version = profile_version + 1 WHERE id = $2', [avatarId, userId])
        if (update.rowCount !== 1) throw new ProfileError(404)
        return { previousAvatar: row.avatar_key, snapshot: this.toSnapshot(await this.readUser(userId, tx)) }
      })
      previousAvatar = result.previousAvatar
      snapshot = result.snapshot
    } catch (error) {
      await unlink(finalPath).catch(() => undefined)
      throw error
    }
    if (previousAvatar !== null) {
      await this.removeUnreferencedAvatar(previousAvatar)
    }
    return snapshot
  }

  async readAvatar(avatarId: string): Promise<Buffer> {
    if (!AVATAR_ID.test(avatarId)) throw new ProfileError(404)
    const referenced = await this.db.query('SELECT 1 FROM auth_users WHERE avatar_key = $1', [avatarId])
    if (referenced.rows.length === 0) throw new ProfileError(404)
    try {
      return await readFile(resolve(this.avatarDirectory, `${avatarId}.webp`))
    } catch (error) {
      console.error('[server] referenced avatar file is missing', { avatarId, error })
      throw new ProfileError(404)
    }
  }

  private async readUser(userId: string, executor: SqlExecutor = this.db, lock = false): Promise<UserProfileRow> {
    const row = (await executor.query<UserProfileRow>(`
      SELECT id, email, nickname, qq, fivem_id, avatar_key FROM auth_users WHERE id = $1${lock ? ' FOR UPDATE' : ''}
    `, [userId])).rows[0]
    if (row === undefined) throw new ProfileError(404)
    return row
  }

  private toSnapshot(row: UserProfileRow) {
    return {
      id: row.id,
      email: row.email,
      nickname: row.nickname,
      qq: row.qq,
      fivemId: row.fivem_id,
      avatarUrl: row.avatar_key === null ? null : `${this.publicAvatarBaseUrl}/${row.avatar_key}`,
    }
  }

  private async removeUnreferencedAvatar(avatarId: string): Promise<void> {
    if ((await this.db.query('SELECT 1 FROM auth_users WHERE avatar_key = $1', [avatarId])).rows.length !== 0) return
    try {
      await unlink(resolve(this.avatarDirectory, `${avatarId}.webp`))
    } catch (error) {
      console.error('[server] could not remove replaced avatar file', { avatarId, error })
    }
  }
}

function decodeImage(value: string): Buffer {
  if (typeof value !== 'string') throw new ProfileError(400)
  if (value.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 4) throw new ProfileError(413)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProfileError(400)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) throw new ProfileError(bytes.length > MAX_INPUT_BYTES ? 413 : 400)
  return bytes
}
