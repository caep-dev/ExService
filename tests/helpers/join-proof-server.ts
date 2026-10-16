import { createApp } from '@server/src/app.ts'
import { createTestAuth, joinActor } from '@tests/helpers/auth.ts'
import { stopTestPostgres } from '@tests/helpers/postgres.ts'

// Isolated process fixture: its PostgreSQL container and schema are owned by this process.
const fixture = await createTestAuth()
const actor = await joinActor(fixture)
const app = createApp({ ...fixture })
process.once('SIGTERM', () => {
  app.server.closeAllConnections()
  void app.close().finally(async () => {
    await fixture.close()
    await stopTestPostgres()
    process.exit(0)
  })
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (address === null || typeof address === 'string')
  throw new Error('Missing isolated socket address')
process.send?.({
  port: address.port,
  avatarDirectory: fixture.avatarDirectory,
  authorization: actor.authorization,
})
