import { createApp, type CreateAppOptions } from "@server/src/app.js";
import { createSupportServices } from './domains/support/service.js';
import { createClickUpServices } from './modules/clickup/factory.js';
import { readClickUpConfig } from './modules/clickup/config.js';
import { startApplication, APPLICATION_CLEANUP_FAILED } from "@server/src/start-application.js";
import { BusinessPluginLoadError, formatBusinessPluginError } from "@server/src/business-plugin-errors.js";
import { parseAuthCodeHmacKey } from "@server/src/modules/auth/crypto.js";
import { assertAuthSchemaAvailable } from "@server/src/modules/auth/service.js";
import { createAuthServices, createRegistrationServices } from "@server/src/create-services.js";
import { developmentRegistrationMailer, RegistrationMailConfigurationError } from './development-registration-mailer.js';
import { validateOrigin } from './modules/identity-links/api/source.js';
import { openDatabase } from "@server/src/db/client.js";
import { assertDatabaseReady } from "@server/src/db/schema-check.js";
import { assertCommunitySchemaAvailable } from "@server/src/domains/community/schema-check.js";
import {
  ProfileService,
  avatarDirectory,
  publicAvatarBaseUrl,
} from "@server/src/modules/profile/service.js";
import { assertProfileSchemaAvailable } from "@server/src/modules/profile/schema-check.js";
import { assertJoinSchemaAvailable } from "@server/src/domains/join/applications/schema-check.js";
import { createStorageModule } from "@server/src/modules/storage/factory.js";
import {
  parseStorageConfig,
  StorageConfigError,
} from "@server/src/modules/storage/config.js";
import {
  CorsConfigError,
  parseCorsAllowedOrigins,
} from "@server/src/http/cors.js";
import {
  HttpHydraAdmin,
  OidcService,
} from "@server/src/modules/identity/oidc.js";
import {
  configuredIdentityOutboxWorker,
  startIdentityOutboxWorker,
} from "@server/src/modules/identity/outbox.js";
import {
  IdentityConfigError,
  parseIdentityConfig,
} from "@server/src/modules/identity/config.js";
import { assertDeploymentBinding } from "@server/src/modules/identity/deployment-binding.js";
import { parseCfxConfig, CfxConfigError } from "@server/src/modules/cfx/config.js";
import { createCfxServices } from "@server/src/modules/cfx/service.js";
import {
  createNotificationModule,
  deriveNotificationTokenKey,
  type NotificationModule,
} from "@server/src/modules/notifications/factory.js";

const PORT = Number(process.env.SERVER_PORT ?? "8080");
const HOST = process.env.SERVER_HOST ?? "127.0.0.1";
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("SERVER_PORT 必须是有效端口。");
}

try {
  // 配置在监听前解析为不可变对象；非法配置直接失败，不输出变量值或底层异常。
  const identity = parseIdentityConfig();
  assertDeploymentBinding(identity);
  const storageConfig = parseStorageConfig();
  const cfxServices = createCfxServices({ config: parseCfxConfig() });
  const mailer = developmentRegistrationMailer(process.env);
  const publicOrigin = identity.enabled ? identity.publicOrigin : process.env.SERVER_PUBLIC_WEB_BASE_URL;
  if (!publicOrigin) throw new Error('Trusted public origin is required.');
  validateOrigin({publicOrigin,production:process.env.NODE_ENV === 'production'});
  const corsAllowedOrigins = parseCorsAllowedOrigins(
    process.env.SERVER_CORS_ALLOWED_ORIGINS,
  );
  const storageServices = createStorageModule({ config: storageConfig });
  const db = await openDatabase();
  let prepared: {
    appOptions: CreateAppOptions;
    notifications: NotificationModule;
    outbox: ReturnType<typeof configuredIdentityOutboxWorker> | undefined;
  };
  try {
    await assertDatabaseReady(db);
    await assertAuthSchemaAvailable(db);
    await assertProfileSchemaAvailable(db);
    await assertCommunitySchemaAvailable(db);
    await assertJoinSchemaAvailable(db);
    const { authServices, passwordHasher } =
      createAuthServices({
        db,
        codeHmacKey: parseAuthCodeHmacKey(process.env.AUTH_CODE_HMAC_KEY),
        publicWebBaseUrl: identity.enabled
          ? identity.publicOrigin
          : process.env.SERVER_PUBLIC_WEB_BASE_URL,
        publicAvatarBaseUrl: publicAvatarBaseUrl(
          process.env.SERVER_PUBLIC_AVATAR_BASE_URL,
        ),
      });
    const profileServices = new ProfileService(
      db,
      avatarDirectory(process.env.SERVER_AVATAR_DIRECTORY),
      publicAvatarBaseUrl(process.env.SERVER_PUBLIC_AVATAR_BASE_URL),
    );
    const oidcServices = identity.enabled
      ? new OidcService({
          db,
          authServices,
          admin: new HttpHydraAdmin(identity.hydraAdminUrl),
          issuer: identity.issuer,
          flowKey: Buffer.from(identity.keys.flow, "hex"),
          clients: identity.approvedClients,
        })
      : undefined;
    const notifications = createNotificationModule({
      db,
      tokenKey: deriveNotificationTokenKey(
        process.env.SERVER_NOTIFICATION_TOKEN_KEY,
        parseAuthCodeHmacKey(process.env.AUTH_CODE_HMAC_KEY),
      ),
    });
    await notifications.assertReady();
    const clickupServices = createClickUpServices(readClickUpConfig(process.env));
    const supportServices = createSupportServices({ db, clickup: clickupServices, profile: profileServices });
    const registration = createRegistrationServices({db,authServices,passwordHasher,
      codeHmacKey:parseAuthCodeHmacKey(process.env.AUTH_CODE_HMAC_KEY),cfxServices,notifications,mailer});
    const appOptions: CreateAppOptions = {
      authServices,
      profileServices,
      ...registration,
      storageServices,
      notifications,
      clickupServices,
      supportServices,
      cfxServices,
      publicOrigin,
      production:process.env.NODE_ENV === 'production',
      identityKeys: identity.enabled
        ? {
            clients: { ...identity.integrationClients },
            bootstrapKey: identity.keys.bootstrap,
          }
        : undefined,
      oidcServices,
      logger: true,
      trustProxy: ["loopback"],
      corsAllowedOrigins,
    };
    const outbox = identity.enabled
      ? configuredIdentityOutboxWorker(db, identity)
      : undefined;
    prepared = { appOptions, notifications, outbox };
  } catch (error) {
    try { await db.close(); } catch { console.error(APPLICATION_CLEANUP_FAILED); }
    throw error;
  }
  // 从调用开始移交所有权；worker 只在监听成功后启动。
  await startApplication({
    createApp: () => createApp(prepared.appOptions),
    database: db,
    listen: { port: PORT, host: HOST },
    startProjection: () => prepared.notifications.startWorker(),
    recoverSupport: () => prepared.appOptions.supportServices.recover(),
    drainSupport: () => prepared.appOptions.supportServices.close(),
    startOutbox: prepared.outbox ? () => startIdentityOutboxWorker(prepared.outbox!) : undefined,
    reportCleanupFailure: message => console.error(message),
  });
} catch (error) {
  // 存储配置错误自带安全文案：只列出缺失或非法的变量名分类，不含变量值。
  if (error instanceof BusinessPluginLoadError) {
    console.error(formatBusinessPluginError(error));
  } else if (error instanceof IdentityConfigError) {
    console.error(
      `[server] ${error.message}; 请核对根 .env.local 中的身份配置。`,
    );
  } else if (
    error instanceof StorageConfigError ||
    error instanceof CfxConfigError ||
    error instanceof CorsConfigError ||
    error instanceof RegistrationMailConfigurationError
  ) {
    console.error(`[server] 启动失败：${error.message}`);
  } else {
    console.error(
      "[server] 启动失败。请确认 DATABASE_URL 指向 exre，已显式运行 pnpm db:migrate，并配置 AUTH_CODE_HMAC_KEY。",
    );
  }
  process.exitCode = 1;
}
