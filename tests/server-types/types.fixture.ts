import type { createApp, CreateAppOptions, serviceHandlers } from '@workspace/server'
import type { ApiRequest, ApiJsonResult } from '@server/src/http/handler-types.js'
import type { AuthPluginOptions } from '@server/src/modules/auth/plugin.js'
import type { IdentityPluginOptions } from '@server/src/modules/identity/plugin.js'
import type { JoinPluginOptions } from '@server/src/domains/join/plugin.js'
import type { ProfilePluginOptions } from '@server/src/modules/profile/plugin.js'
import type { StoragePluginOptions } from '@server/src/modules/storage/plugin.js'
import type { NotificationsPluginOptions } from '@server/src/modules/notifications/plugin.js'
import { requireBusinessServices } from '@server/src/business-plugin-errors.js'

declare const app: ReturnType<typeof createApp>
declare const loginRequest: ApiRequest<'login'>
declare const authOptions: AuthPluginOptions
declare const joinOptions: JoinPluginOptions
declare const identityOptions: IdentityPluginOptions
declare const options: CreateAppOptions

const token: Promise<ApiJsonResult<'login'>> = app.authServices.login(loginRequest.body)
const services: AuthPluginOptions = { authServices: options.authServices }
const join: JoinPluginOptions = { joinServices: options.joinServices }
const optionalIdentity: IdentityPluginOptions = {}
const namedIdentity: IdentityPluginOptions = { oidcServices: options.oidcServices }
const profile: ProfilePluginOptions = { profileServices: options.profileServices }
const storage: StoragePluginOptions = { storageServices: options.storageServices }
const notifications: NotificationsPluginOptions = { notifications: options.notifications }
void [namedIdentity, profile, storage, notifications]
void [token, services, join, optionalIdentity, authOptions, joinOptions, identityOptions]

// @ts-expect-error decorators must keep their exact names
app.authService.login(loginRequest.body)
// @ts-expect-error generated request body rejects wrong field types
loginRequest.body.password = 123
// @ts-expect-error generated request body rejects misspelled fields
loginRequest.body.passwrod
// @ts-expect-error a service is required at the business plugin boundary
const missing: AuthPluginOptions = {}
// @ts-expect-error plugin service options reject another module's service
const wrong: AuthPluginOptions = { authServices: options.profileServices }
// @ts-expect-error the previous generic parameter is not a compatibility branch
const previous: AuthPluginOptions = { services: options.authServices }
// @ts-expect-error the account-owned join service is required
const incompleteJoin: JoinPluginOptions = {}
// @ts-expect-error invitation services have been retired from runtime
app.invitationServices
// @ts-expect-error safe diagnostics only accept the known service field names
requireBusinessServices('business-auth', { arbitrarySecret: undefined })
void [previous, incompleteJoin]
// @ts-expect-error service parameters remain typed
app.authServices.authenticateToken(123)
// @ts-expect-error identity integration may be disabled
app.oidcServices.inspect('login', 'challenge')
declare const protectedRequest: ApiRequest<'getCurrentUser'>
// @ts-expect-error declaration merging does not imply an authenticated request
protectedRequest.authSession.userId
if (protectedRequest.authSession) {
  const userId: string = protectedRequest.authSession.userId
  void userId
}
declare const health: Awaited<ReturnType<typeof serviceHandlers.getHealth>>
const status: 'ok' = health.status
// @ts-expect-error handler results retain literal Contract fields
const badStatus: typeof status = 'down'
void [missing, wrong, badStatus]
