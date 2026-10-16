import { parseAuthCodeHmacKey } from '@server/src/modules/auth/crypto.js'
import { assertAuthSchemaAvailable, AuthService } from '@server/src/modules/auth/service.js'
import { assertCommunitySchemaAvailable } from '@server/src/domains/community/schema-check.js'
import type { AppDatabase } from '@server/src/db/client.js'
import { assertDatabaseReady } from '@server/src/db/schema-check.js'
import { parseCorsAllowedOrigins } from '@server/src/http/cors.js'
import { publicWebBaseUrl } from '@server/src/http/public-origin.js'
import { assertJoinSchemaAvailable } from '@server/src/domains/join/applications/schema-check.js'
import { parseStorageConfig } from '@server/src/modules/storage/config.js'
import { avatarDirectory, publicAvatarBaseUrl } from '@server/src/modules/profile/service.js'
import { assertProfileSchemaAvailable } from '@server/src/modules/profile/schema-check.js'
import { parseIdentityConfig } from '@server/src/modules/identity/config.js'

import { IdentityReadinessError } from '@server/src/modules/identity/errors.js'
export { IdentityReadinessError } from '@server/src/modules/identity/errors.js'

export function validateWebsiteIntegrationPreflight(env: NodeJS.ProcessEnv = process.env): void {
  parseIdentityConfig(env)
  const checks: Array<[string, () => unknown]> = [
    ['INTEGRATION_CHECK_AUTH_KEY_INVALID', () => parseAuthCodeHmacKey(env.AUTH_CODE_HMAC_KEY)],
    ['INTEGRATION_CHECK_STORAGE_INVALID', () => parseStorageConfig(env)],
    ['INTEGRATION_CHECK_CORS_INVALID', () => parseCorsAllowedOrigins(env.SERVER_CORS_ALLOWED_ORIGINS)],
    ['INTEGRATION_CHECK_PUBLIC_WEB_INVALID', () => publicWebBaseUrl(env.SERVER_PUBLIC_WEB_BASE_URL)],
    ['INTEGRATION_CHECK_AVATAR_INVALID', () => { avatarDirectory(env.SERVER_AVATAR_DIRECTORY); publicAvatarBaseUrl(env.SERVER_PUBLIC_AVATAR_BASE_URL) }],
  ]
  for (const [code, check] of checks) {
    try { check() } catch { throw new IdentityReadinessError(code) }
  }
}

export function parseIntegrationCheckArguments(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--admin-user-id' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[1]!)) {
    throw new IdentityReadinessError('INTEGRATION_CHECK_ARGUMENTS_INVALID')
  }
  return args[1]
}

/** A consistent read-only snapshot; no auth cleanup or preparation entry points. */
export async function assertWebsiteIntegrationReady(db: AppDatabase, adminUserId?: string,
  schema = 'public', migrationsSchema = 'drizzle'): Promise<void> {
  await db.transaction(async tx => {
    try {
      await assertDatabaseReady(tx, schema, migrationsSchema)
      await assertAuthSchemaAvailable(tx)
      await assertProfileSchemaAvailable(tx)
      await assertCommunitySchemaAvailable(tx)
      await assertJoinSchemaAvailable(tx)
    } catch { throw new IdentityReadinessError('INTEGRATION_CHECK_SCHEMA_NOT_READY') }
    if (adminUserId) {
      const auth = new AuthService({ db: { ...db, query: tx.query } })
      if (!await auth.inspectIdentityUser(adminUserId)) {
        throw new IdentityReadinessError('INTEGRATION_CHECK_ADMIN_NOT_ACTIVE')
      }
    }
  }, 'repeatable-read-read-only')
}
