import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [directory, extension, probe] = process.argv.slice(2)
const load = path => import(pathToFileURL(join(directory, `${path}.${extension}`)).href)
const { createApp } = await load('app')
const { createAuthServices,createRegistrationServices } = await load('create-services')
const {createCfxServices}=await load('modules/cfx/service')
const { ProfileService } = await load('modules/profile/service')
const { createStorageModule } = await load('modules/storage/factory')
const { parseStorageConfig } = await load('modules/storage/config')
const { createNotificationModule } = await load('modules/notifications/factory')
const { startApplication } = await load('start-application')
const { createClickUpServices } = await load('modules/clickup/factory')
const { createSupportServices } = await load('domains/support/service')
const { BusinessPluginLoadError, formatBusinessPluginError } = await load('business-plugin-errors')
const owned = mkdtempSync(join(tmpdir(), 'exwebsite-env-'))
let closes = 0, starts = 0
const database = {
  query: async sql => {if(sql.startsWith('UPDATE auth_registration_deliveries SET status='))return {rows:[],rowCount:0};throw new Error('NO_BUSINESS_DATABASE_QUERIES_ALLOWED')},
  transaction: async run => run(database),
  close: async () => { closes++ },
}
const auth=createAuthServices({db:database,codeHmacKey:Buffer.alloc(32,7)}),cfxServices=createCfxServices({config:{enabled:false}});
const notifications=createNotificationModule({db:database,tokenKey:Buffer.alloc(32,3)});
const services = {
  ...auth,cfxServices,...createRegistrationServices({db:database,...auth,codeHmacKey:Buffer.alloc(32,7),cfxServices,notifications}),
  profileServices: new ProfileService(database, owned, 'http://localhost/api/avatars'),
  storageServices: createStorageModule({ config: parseStorageConfig({}, { dataRoot: owned }) }),
  notifications,
}
services.clickupServices = createClickUpServices({ kind: 'disabled' })
services.supportServices = createSupportServices({ db: database, clickup: services.clickupServices, profile: services.profileServices })
try {
  const app = await startApplication({
    createApp: () => createApp(services), database,
    listen: { port: 0, host: '127.0.0.1' },
    startProjection: () => { starts++; const timer = setInterval(() => { throw new Error('WORKER_RETRY_SENTINEL') }, 100); return () => clearInterval(timer) },
    reportCleanupFailure: console.error,
  })
  if (probe && !app.hasDecorator(probe)) throw new Error('EXPECTED_PROBE_MISSING')
  if (app.hasDecorator('removed')) throw new Error('STALE_PLUGIN_LOADED')
  if ((await app.inject('/api/health')).statusCode !== 200) throw new Error('HEALTH_FAILED')
  await app.close()
  console.log(JSON.stringify({ closes, starts, status: 'ok' }))
} catch (error) {
  if (!(error instanceof BusinessPluginLoadError)) throw error
  console.error(formatBusinessPluginError(error))
  console.log(JSON.stringify({ closes, starts }))
  process.exitCode = 1
} finally { rmSync(owned, { recursive: true, force: true }) }
