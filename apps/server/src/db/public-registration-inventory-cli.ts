import { assertCliEntry, openDatabase } from './client.js'
import { inspectPublicRegistrationHistory } from './public-registration-inventory.js'

assertCliEntry(import.meta.url)
try {
  const db = await openDatabase()
  try {
    const result = await db.transaction(inspectPublicRegistrationHistory, 'repeatable-read-read-only')
    console.log(JSON.stringify(result))
    if (Object.keys(result.conflicts).length) process.exitCode = 1
  } finally { await db.close() }
} catch {
  console.error('PUBLIC_REGISTRATION_INVENTORY_FAILED')
  process.exitCode = 1
}
