import type { KeyObject } from 'node:crypto'
import { CFX_LIMITS } from './config.js'
import type { CfxAttemptStatus, CfxFailureCode, CfxIdentity } from './types.js'

export type CfxState = CfxAttemptStatus['state']
export interface CfxBinding { deadline: number; committed: boolean; reservations: number }
export interface CfxAttempt {
  id: string; binding: string; state: CfxState; deadline: number; expiresAt: number; version: number
  privateKey?: KeyObject; nonce?: string; clientId?: string; controller?: AbortController
  identity?: CfxIdentity; ticket?: string; ticketDigest?: string; failureCode?: CfxFailureCode
}
export function isActive(state: CfxState) { return state === 'pending' || state === 'processing' || state === 'ready' }

/** Owns all record/index mutations; transitions never await. */
export class CfxStateStore {
  readonly attempts = new Map<string, CfxAttempt>()
  readonly bindings = new Map<string, CfxBinding>()
  readonly tickets = new Map<string, string>()
  reservations = 0

  terminal(attempt: CfxAttempt, state: 'cancelled' | 'expired' | 'failed' | 'consumed', now: number, wall: number, failureCode?: CfxFailureCode) {
    const controller = attempt.controller
    attempt.version++
    attempt.state = state; attempt.deadline = now + CFX_LIMITS.terminalMs; attempt.expiresAt = wall + CFX_LIMITS.terminalMs
    delete attempt.identity; delete attempt.ticket; delete attempt.privateKey; delete attempt.nonce; delete attempt.clientId; delete attempt.controller
    attempt.failureCode = failureCode
    controller?.abort()
  }

  sweep(now: number, wall: number) {
    for (const [id, attempt] of this.attempts) {
      if (now >= attempt.deadline && isActive(attempt.state)) {
        // Expiry is anchored to the original deadline, even when sweep runs late.
        const deadline = attempt.deadline, expiresAt = attempt.expiresAt
        this.terminal(attempt, 'expired', deadline, expiresAt)
      }
      if (now >= attempt.deadline && !isActive(attempt.state)) {
        if (attempt.ticketDigest) this.tickets.delete(attempt.ticketDigest)
        this.attempts.delete(id)
      }
    }
    for (const [key, binding] of this.bindings) if (!binding.reservations && now >= binding.deadline) this.bindings.delete(key)
  }

  active(binding: string) {
    let total = this.bindings.get(binding)?.reservations ?? 0
    for (const attempt of this.attempts.values()) if (attempt.binding === binding && isActive(attempt.state)) total++
    return total
  }

  clear(now: number, wall: number) {
    for (const attempt of this.attempts.values()) this.terminal(attempt, 'cancelled', now, wall)
    this.attempts.clear(); this.tickets.clear()
  }
}
