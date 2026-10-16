import type { AuthService } from './modules/auth/service.js'
import type { ProfileService } from './modules/profile/service.js'
import type { JoinService } from './domains/join/applications/service.js'
import type { OidcService } from './modules/identity/oidc.js'
import type { StorageServices } from './modules/storage/factory.js'
import type { NotificationModule } from './modules/notifications/factory.js'
import type { ClickUpServices } from './modules/clickup/service.js'
import type { SupportServices } from './domains/support/service.js'
import type { CfxServices } from './modules/cfx/types.js'
import type { IdentityLinkService } from './modules/identity-links/service.js'
import type { RegistrationService } from './modules/registration/service.js'
import type { CommunityService } from './modules/communities/service.js'
import type { ExternalAccountService } from './modules/external-accounts/service.js'

/** Application-owned services; freezing the snapshot never freezes these instances. */
export interface BusinessServices {
  readonly authServices: AuthService
  readonly profileServices: ProfileService
  readonly joinServices: JoinService
  readonly oidcServices?: OidcService
  readonly storageServices: StorageServices
  readonly notifications: NotificationModule
  readonly clickupServices: ClickUpServices
  readonly supportServices: SupportServices
  readonly cfxServices?: CfxServices
  readonly identityLinkServices: IdentityLinkService
  readonly externalAccountServices?: ExternalAccountService
  readonly registrationServices: RegistrationService
  readonly communityServices: CommunityService
}
