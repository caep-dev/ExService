import type { AppDatabase } from "@server/src/db/client.js";
import { ScryptPasswordHasher } from "@server/src/modules/auth/crypto.js";
import { AuthService } from "@server/src/modules/auth/service.js";
import { JoinService } from "@server/src/domains/join/applications/service.js";
import { IdentityLinkService } from './modules/identity-links/service.js';
import { RegistrationService, type RegistrationMailer } from './modules/registration/service.js';
import { CommunityService } from './modules/communities/service.js';
import type { CfxServices } from './modules/cfx/types.js';
import type { NotificationModule } from './modules/notifications/factory.js';
import { ExternalAccountService } from './modules/external-accounts/service.js';

/** Pure production assembly: no database open, startup checks, migrations or writes. */
export function createAuthServices(options: {
  db: AppDatabase;
  codeHmacKey: Buffer;
  publicWebBaseUrl?: string;
  publicAvatarBaseUrl?: string;
}) {
  const passwordHasher = new ScryptPasswordHasher();
  const authServices = new AuthService({
    db: options.db,
    passwordHasher,
    publicAvatarBaseUrl: options.publicAvatarBaseUrl,
  });
  return { authServices, passwordHasher };
}

/** Assemble browser registration and account-owned community services without starting work. */
export function createRegistrationServices(options:{db:AppDatabase;authServices:AuthService;passwordHasher:ScryptPasswordHasher;codeHmacKey:Buffer;cfxServices:CfxServices;notifications:NotificationModule;mailer?:RegistrationMailer}) {
  const {db,authServices,passwordHasher,codeHmacKey,cfxServices,notifications,mailer}=options;
  const externalAccounts=new ExternalAccountService({db,auth:authServices,cfx:cfxServices});
  const identityLinkServices=new IdentityLinkService({db,auth:authServices,cfx:cfxServices,externalAccounts});
  const registrationServices=new RegistrationService({db,auth:authServices,identityLinks:identityLinkServices,externalAccounts,passwordHasher,codeHmacKey,mailer});
  const communityServices=new CommunityService({db,authServices,identityLinkServices});
  const joinServices=new JoinService({db,authServices,communityServices,identityLinkServices,notifications});
  return {externalAccountServices:externalAccounts,identityLinkServices,registrationServices,communityServices,joinServices};
}
