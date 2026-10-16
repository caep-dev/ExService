import { CFX_LIMITS } from './config.js'
import { CfxError } from './errors.js'
import type { CfxIdentity } from './types.js'

export type CfxFetch = (url: string, init: RequestInit) => Promise<Response>
const origin = 'https://forum.cfx.re'

/** Races injected transports as well as aborting real network and body reads. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CfxError('CFX_UPSTREAM_TIMEOUT'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

async function getJson(fetch: CfxFetch, path: string, key: string, clientId: string, outerSignal: AbortSignal): Promise<unknown> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), CFX_LIMITS.requestMs); timer.unref()
  const signal = AbortSignal.any([outerSignal, timeout.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await abortable(fetch(`${origin}${path}`, { method: 'GET', redirect: 'manual', signal,
      headers: { 'User-Api-Key': key, 'User-Api-Client-Id': clientId, Accept: 'application/json' } }), signal)
    if (response.status !== 200 || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      void response.body?.cancel().catch(() => {})
      if (path.startsWith('/u/') && [401, 403].includes(response.status)) throw new CfxError('CFX_EMAIL_UNAVAILABLE')
      throw new CfxError('CFX_UPSTREAM_UNAVAILABLE')
    }
    if (!response.body) throw new CfxError('CFX_UPSTREAM_UNAVAILABLE')
    reader = response.body.getReader()
    let total = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (next.done) break
      total += next.value.byteLength
      if (total > CFX_LIMITS.responseBytes) throw new CfxError('CFX_UPSTREAM_UNAVAILABLE')
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } catch (error) {
    if (signal.aborted) throw new CfxError('CFX_UPSTREAM_TIMEOUT')
    if (error instanceof CfxError) throw error
    throw new CfxError('CFX_UPSTREAM_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    if (reader) void reader.cancel().catch(() => {})
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function readIdentity(fetch: CfxFetch, key: string, clientId: string, signal: AbortSignal): Promise<CfxIdentity> {
  const user = object(object(await getJson(fetch, '/session/current.json', key, clientId, signal)).current_user)
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id < 1 ||
      typeof user.username !== 'string' || !user.username || [...user.username].length > 128 || user.username !== user.username.trim() || /[\u0000-\u001f\u007f]/u.test(user.username) ||
      typeof user.avatar_template !== 'string' || !user.avatar_template) throw new CfxError('CFX_USER_INVALID')
  let avatar: URL
  try {
    const template = user.avatar_template.replaceAll('{size}', '512')
    if (/[{}]/.test(template) || /[\u0000-\u0020\u007f\\]/u.test(template)) throw new Error()
    avatar = new URL(template, origin)
    if (avatar.protocol !== 'https:' || avatar.username || avatar.password || avatar.hash || [...avatar.href].length > 2048) throw new Error()
  } catch { throw new CfxError('CFX_USER_INVALID') }
  let usernamePath: string
  try { usernamePath = encodeURIComponent(user.username) } catch { throw new CfxError('CFX_USER_INVALID') }
  const value = object(await getJson(fetch, `/u/${usernamePath}/emails.json`, key, clientId, signal)).email
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ([...email].length < 3 || [...email].length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CfxError('CFX_EMAIL_UNAVAILABLE')
  return { id: String(user.id), username: user.username, avatarUrl: avatar.href, email }
}
