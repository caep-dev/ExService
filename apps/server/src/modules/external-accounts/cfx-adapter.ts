import type { CfxBrowserContext, CfxServices } from '../cfx/types.js'

const proofBrand: unique symbol = Symbol('verified-external-identity')
const issued = new WeakSet<object>()

export type VerifiedExternalIdentity = Readonly<{
  provider: 'cfx'
  subject: string
  username: string
  providerEmail: string
  [proofBrand]: true
}>

export function consumeCfxIdentity(
  cfx: CfxServices,
  context: CfxBrowserContext,
  identityTicket: string,
  expectedAttemptId?: string,
): VerifiedExternalIdentity {
  // Consumption is synchronous so a ready ticket cannot be used twice across awaiting requests.
  const identity = cfx.consumeIdentity({ context, identityTicket, expectedAttemptId })
  const proof = Object.freeze({
    provider: 'cfx' as const,
    subject: identity.id,
    username: identity.username,
    providerEmail: identity.email,
    [proofBrand]: true as const,
  })
  issued.add(proof)
  return proof
}

export function assertVerifiedExternalIdentity(proof: VerifiedExternalIdentity): void {
  if (!proof || !issued.has(proof)) throw new Error('Unverified external identity')
}
