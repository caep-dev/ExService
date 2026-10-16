import { randomBytes } from 'node:crypto'
import { CFX_LIMITS, type CfxConfig } from './config.js'
import { decodePayload, decryptAuthorization, digest, generateKeys, opaquePattern, randomToken, type CfxKeys } from './crypto.js'
import { CfxError } from './errors.js'
import { readIdentity, type CfxFetch } from './forum-client.js'
import { CfxRateLimiter, type CfxRequestKind } from './rate-limiter.js'
import { CfxStateStore, isActive, type CfxAttempt } from './state-store.js'
import type { CfxAttemptStatus, CfxBrowserContext, CfxFailureCode, CfxServices } from './types.js'

export interface CfxDependencies {
  config: CfxConfig
  now?: () => number
  wallNow?: () => number
  generateKeys?: () => Promise<CfxKeys>
  fetch?: CfxFetch
  randomToken?: () => string
}

export function createCfxServices(dependencies: CfxDependencies): CfxServices {
  const config = dependencies.config
  const now = dependencies.now ?? (() => performance.now()), wall = dependencies.wallNow ?? Date.now
  const keys = dependencies.generateKeys ?? generateKeys, fetch = dependencies.fetch ?? globalThis.fetch
  const token = dependencies.randomToken ?? randomToken
  const store = new CfxStateStore(), limiter = new CfxRateLimiter(), work = new Set<Promise<unknown>>()
  let closed = false, timer: ReturnType<typeof setInterval> | undefined, closing: Promise<void> | undefined
  let generating = 0, processing = 0

  function sweep() { store.sweep(now(), wall()); limiter.sweep(now()) }
  function available() {
    if (closed) throw new CfxError('CFX_SERVICE_CLOSED')
    if (!config.enabled) throw new CfxError('CFX_DISABLED')
    sweep()
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise)
    void promise.then(() => work.delete(promise), () => work.delete(promise))
    return promise
  }
  function unique(occupied: (value: string) => boolean): string {
    for (let i = 0; i < 4; i++) {
      const value = token()
      if (!opaquePattern.test(value)) throw new Error('Cfx identifier generation failed.')
      if (!occupied(value)) return value
    }
    throw new Error('Cfx identifier generation failed.')
  }
  function bindingFor(context: CfxBrowserContext) {
    const binding = store.bindings.get(context.bindingDigest)
    if (!binding?.committed || now() >= binding.deadline) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
    return binding
  }
  function request(kind: CfxRequestKind, context: CfxBrowserContext) {
    available(); bindingFor(context)
    limiter.check(kind, 'ip', context.clientIp, now())
    limiter.check(kind, 'binding', context.bindingDigest, now())
  }
  function owned(context: CfxBrowserContext, id: string) {
    const attempt = store.attempts.get(id)
    if (!attempt || attempt.binding !== context.bindingDigest) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
    return attempt
  }
  function status(attempt: CfxAttempt): CfxAttemptStatus {
    const common = { attemptId: attempt.id, expiresAt: attempt.expiresAt }
    if (attempt.state === 'ready') return { ...common, state: 'ready', identity: { ...attempt.identity! }, identityTicket: attempt.ticket!, ticketExpiresAt: attempt.expiresAt }
    if (attempt.state === 'failed') return { ...common, state: 'failed', failureCode: attempt.failureCode! }
    return { ...common, state: attempt.state }
  }

  async function begin(input: Parameters<CfxServices['begin']>[0]) {
    available()
    if (!config.enabled) throw new CfxError('CFX_DISABLED')
    limiter.check('create', 'ip', input.clientIp, now())
    let cookieValue = input.bindingToken && opaquePattern.test(input.bindingToken) ? input.bindingToken : undefined
    let bindingDigest = cookieValue ? digest(cookieValue) : undefined
    let binding = bindingDigest ? store.bindings.get(bindingDigest) : undefined
    if (!binding?.committed || now() >= binding.deadline) {
      if (store.bindings.size >= CFX_LIMITS.bindings) throw new CfxError('CFX_CAPACITY_EXCEEDED')
      cookieValue = unique(value => store.bindings.has(digest(value)))
      bindingDigest = digest(cookieValue)
      binding = { committed: false, deadline: now() + CFX_LIMITS.bindingMs, reservations: 0 }
    }
    limiter.check('create', 'binding', bindingDigest!, now())
    if (store.attempts.size + store.reservations >= CFX_LIMITS.attempts ||
        store.active(bindingDigest!) >= CFX_LIMITS.activePerBinding || generating >= CFX_LIMITS.generation) throw new CfxError('CFX_CAPACITY_EXCEEDED')
    if (input.signal?.aborted) throw new CfxError('CFX_ATTEMPT_CONFLICT')
    store.bindings.set(bindingDigest!, binding); binding.reservations++; store.reservations++; generating++
    try {
      const pair = await keys()
      if (closed) throw new CfxError('CFX_SERVICE_CLOSED')
      if (input.signal?.aborted) throw new CfxError('CFX_ATTEMPT_CONFLICT')
      sweep()
      const id = unique(value => store.attempts.has(value))
      const nonce = randomBytes(16).toString('hex'), clientId = randomBytes(48).toString('hex')
      const url = new URL('https://forum.cfx.re/user-api-key/new')
      for (const [key, value] of Object.entries({ application_name: config.applicationName, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        nonce, client_id: clientId, scopes: 'session_info,read', padding: 'oaep' })) url.searchParams.set(key, value)
      if (config.mode === 'redirect') {
        const callback = new URL('/api/auth/cfx/callback', config.publicOrigin); callback.searchParams.set('attemptId', id)
        url.searchParams.set('auth_redirect', callback.href)
      }
      const expiresAt = wall() + CFX_LIMITS.attemptMs
      store.attempts.set(id, { id, binding: bindingDigest!, state: 'pending', deadline: now() + CFX_LIMITS.attemptMs, expiresAt, version: 0, privateKey: pair.privateKey, nonce, clientId })
      binding.committed = true; binding.deadline = now() + CFX_LIMITS.bindingMs
      return { response: { attemptId: id, mode: config.mode, authorizationUrl: url.href, expiresAt }, cookieValue: cookieValue! }
    } finally {
      generating--; store.reservations--; binding.reservations--
      if (!binding.committed && !binding.reservations) store.bindings.delete(bindingDigest!)
    }
  }

  async function complete(input: Parameters<CfxServices['complete']>[0]) {
    request('complete', input.context)
    if (!config.enabled || config.mode !== input.source) throw new CfxError('CFX_FLOW_UNAVAILABLE')
    const attempt = owned(input.context, input.attemptId)
    if (attempt.state === 'expired') throw new CfxError('CFX_ATTEMPT_EXPIRED')
    if (attempt.state !== 'pending') throw new CfxError('CFX_ATTEMPT_CONFLICT')
    const bytes = decodePayload(input.payload)
    if (processing >= CFX_LIMITS.processing) throw new CfxError('CFX_CAPACITY_EXCEEDED')
    if (input.signal?.aborted) throw new CfxError('CFX_ATTEMPT_CONFLICT')
    const controller = new AbortController()
    const version = ++attempt.version
    attempt.state = 'processing'; attempt.controller = controller; processing++
    const processingDeadline = Math.min(attempt.deadline, now() + CFX_LIMITS.processingMs)
    const timeout = setTimeout(() => controller.abort(), Math.max(0, processingDeadline - now())); timeout.unref()
    const cancel = () => { if (attempt.state === 'processing' && attempt.version === version) store.terminal(attempt, 'cancelled', now(), wall()) }
    input.signal?.addEventListener('abort', cancel, { once: true })
    let apiKey: string | undefined
    function current(checkTimeout = true) {
      if (closed) throw new CfxError('CFX_SERVICE_CLOSED')
      sweep()
      if (attempt.state === 'expired') throw new CfxError('CFX_ATTEMPT_EXPIRED')
      if (attempt.state !== 'processing' || attempt.version !== version) throw new CfxError('CFX_ATTEMPT_CONFLICT')
      if (checkTimeout && (now() >= processingDeadline || controller.signal.aborted)) throw new CfxError('CFX_UPSTREAM_TIMEOUT')
    }
    try {
      apiKey = decryptAuthorization(bytes, attempt.privateKey!, attempt.nonce!)
      const clientId = attempt.clientId!
      delete attempt.privateKey; delete attempt.nonce; delete attempt.clientId
      current()
      const identity = await readIdentity(fetch, apiKey, clientId, controller.signal)
      current()
      const ticket = unique(value => store.tickets.has(digest(value)))
      attempt.state = 'ready'; attempt.version++; delete attempt.controller
      attempt.deadline = now() + CFX_LIMITS.resultMs; attempt.expiresAt = wall() + CFX_LIMITS.resultMs
      attempt.identity = identity; attempt.ticket = ticket; attempt.ticketDigest = digest(ticket)
      store.tickets.set(attempt.ticketDigest, attempt.id)
      return { attemptId: attempt.id, state: 'ready' as const }
    } catch (error) {
      current(false)
      const failureError = now() >= processingDeadline || controller.signal.aborted ? new CfxError('CFX_UPSTREAM_TIMEOUT') : error
      const failure: CfxFailureCode = failureError instanceof CfxError && ['CFX_INVALID_PAYLOAD', 'CFX_NONCE_INVALID', 'CFX_API_VERSION_UNSUPPORTED', 'CFX_USER_INVALID', 'CFX_EMAIL_UNAVAILABLE', 'CFX_UPSTREAM_UNAVAILABLE', 'CFX_UPSTREAM_TIMEOUT'].includes(failureError.code)
        ? failureError.code as CfxFailureCode : 'CFX_UPSTREAM_UNAVAILABLE'
      store.terminal(attempt, 'failed', now(), wall(), failure)
      throw failureError
    } finally {
      apiKey = undefined; bytes.fill(0)
      delete attempt.privateKey; delete attempt.nonce; delete attempt.clientId
      clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel); processing--
    }
  }

  const service: CfxServices = {
    config,
    start() {
      if (closed || !config.enabled || timer) return
      timer = setInterval(sweep, 1000); timer.unref()
    },
    close() {
      if (!closing) {
        closed = true; if (timer) clearInterval(timer); timer = undefined
        store.clear(now(), wall())
        closing = Promise.allSettled([...work]).then(() => { store.bindings.clear(); limiter.clear() })
      }
      return closing
    },
    begin: input => track(begin(input)),
    resolveBrowserContext(input) {
      available()
      if (!opaquePattern.test(input.bindingToken)) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
      const context = Object.freeze({ bindingDigest: digest(input.bindingToken), clientIp: input.clientIp })
      bindingFor(context); return context
    },
    complete: input => track(complete(input)),
    inspect(context, id) { request('inspect', context); return status(owned(context, id)) },
    cancel(context, id) {
      request('cancel', context)
      const attempt = owned(context, id)
      if (isActive(attempt.state)) store.terminal(attempt, 'cancelled', now(), wall())
      return { attemptId: attempt.id, state: attempt.state as 'cancelled' | 'failed' | 'expired' | 'consumed' }
    },
    consumeIdentity({ context, identityTicket, expectedAttemptId }) {
      available()
      try { bindingFor(context) } catch { throw new CfxError('CFX_IDENTITY_TICKET_INVALID') }
      const id = store.tickets.get(digest(identityTicket)), attempt = id ? store.attempts.get(id) : undefined
      if (!attempt || attempt.binding !== context.bindingDigest) throw new CfxError('CFX_IDENTITY_TICKET_INVALID')
      if (expectedAttemptId !== undefined && attempt.id !== expectedAttemptId) throw new CfxError('CFX_IDENTITY_TICKET_INVALID')
      if (attempt.state === 'expired') throw new CfxError('CFX_IDENTITY_TICKET_EXPIRED')
      if (attempt.state !== 'ready') throw new CfxError('CFX_IDENTITY_TICKET_INVALID')
      const identity = { ...attempt.identity! }
      store.terminal(attempt, 'consumed', now(), wall())
      return identity
    },
  }
  return service
}
