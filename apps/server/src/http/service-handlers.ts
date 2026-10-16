import { operations as auth } from '../modules/auth/api/operations.js'
import { operations as profile } from '../modules/profile/api/operations.js'
import { operations as identity } from '../modules/identity/api/operations.js'
import { operations as join } from '../domains/join/api/operations.js'
import { operations as storage } from '../modules/storage/api/operations.js'
import { operations as notifications } from '../modules/notifications/api/operations.js'
import { operations as system } from './system/operations.js'
import { operations as support } from '../domains/support/api/operations.js'
import { operations as cfx } from '../modules/cfx/api/operations.js'
import { operations as registration } from '../modules/registration/api/operations.js'
import { operations as identityLinks } from '../modules/identity-links/api/operations.js'
import { operations as communities } from '../modules/communities/api/operations.js'

type MergedOperations<Maps extends readonly object[]> =
  Maps extends readonly [infer First extends object, ...infer Rest extends readonly object[]]
    ? First & MergedOperations<Rest> : object

/** Preserve concrete handler signatures while rejecting accidental duplicate registrations. */
export function mergeOperations<const Maps extends readonly object[]>(...maps: Maps): MergedOperations<Maps> {
  const merged: Record<string, unknown> = {}
  for (const map of maps) for (const [operationId, handler] of Object.entries(map)) {
    if (Object.hasOwn(merged, operationId)) throw new Error(`Duplicate operation handler: ${operationId}`)
    Object.defineProperty(merged, operationId, { value: handler, enumerable: true, writable: true, configurable: true })
  }
  return merged as MergedOperations<Maps>
}

export const serviceHandlers = mergeOperations(system, auth, profile, join, identity, storage, notifications, support, cfx, registration, identityLinks, communities)
