import { CFX_LIMITS } from './config.js'
import { CfxError } from './errors.js'

export type CfxRequestKind = 'create' | 'complete' | 'inspect' | 'cancel'
const budgets = { create: [10, 6], complete: [30, 6], inspect: [120, 60], cancel: [30, 10] } as const
export class CfxRateLimiter {
  private readonly counters = new Map<string, { count: number; deadline: number }>()
  sweep(now: number) { for (const [key, value] of this.counters) if (now >= value.deadline) this.counters.delete(key) }
  clear() { this.counters.clear() }
  check(kind: CfxRequestKind, scope: 'ip' | 'binding', identifier: string, now: number) {
    this.sweep(now)
    const key = JSON.stringify([kind, scope, identifier]), budget = budgets[kind][scope === 'ip' ? 0 : 1]
    let counter = this.counters.get(key)
    if (!counter) {
      if (this.counters.size >= CFX_LIMITS.counters) throw new CfxError('CFX_CAPACITY_EXCEEDED')
      counter = { count: 0, deadline: now + CFX_LIMITS.windowMs }; this.counters.set(key, counter)
    }
    if (counter.count >= budget) throw new CfxError('CFX_REQUEST_LIMITED', Math.max(1, Math.ceil((counter.deadline - now) / 1000)))
    counter.count++
  }
}
