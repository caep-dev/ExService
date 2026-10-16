import { constants, generateKeyPairSync, publicEncrypt } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { decodePayload, decryptAuthorization } from '@server/src/modules/cfx/crypto'
import { readIdentity } from '@server/src/modules/cfx/forum-client'
import { CfxRateLimiter } from '@server/src/modules/cfx/rate-limiter'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const nonce = 'a'.repeat(32)
function encrypt(value: Buffer, padding = constants.RSA_PKCS1_OAEP_PADDING) {
  return publicEncrypt({ key: pair.publicKey, padding, oaepHash: 'sha1' }, value)
}
afterEach(() => vi.useRealTimers())

it.each(['', '!!!!', 'A'.repeat(1025), Buffer.alloc(255).toString('base64'), Buffer.alloc(257).toString('base64'), `${Buffer.alloc(256).toString('base64').slice(0, -3)}B==`])('rejects non-canonical or wrong-length Base64 %s', payload => {
  expect(() => decodePayload(payload)).toThrow(expect.objectContaining({ code: 'CFX_INVALID_PAYLOAD' }))
})
it.each([Buffer.from([0xff]), Buffer.from('not JSON'), Buffer.from('[]'), Buffer.from('null')])('rejects malformed decrypted data', data => {
  expect(() => decryptAuthorization(encrypt(data), pair.privateKey, nonce)).toThrow(expect.objectContaining({ code: 'CFX_INVALID_PAYLOAD' }))
})
it('does not fall back to PKCS#1 encryption or accept a different RSA key', () => {
  const json = Buffer.from(JSON.stringify({ key: 'key', nonce, api: 4, push: false }))
  expect(() => decryptAuthorization(encrypt(json, constants.RSA_PKCS1_PADDING), pair.privateKey, nonce)).toThrow(expect.objectContaining({ code: 'CFX_INVALID_PAYLOAD' }))
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  expect(() => decryptAuthorization(encrypt(json), other.privateKey, nonce)).toThrow(expect.objectContaining({ code: 'CFX_INVALID_PAYLOAD' }))
})

it('uses two real controlled HTTP requests with the original headers and encoded session username', async () => {
  const received: Array<{ path: string; key?: string; client?: string }> = []
  const server = createServer((request, response) => {
    received.push({ path: request.url!, key: String(request.headers['user-api-key']), client: String(request.headers['user-api-client-id']) })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url === '/session/current.json' ? { current_user: { id: 10, username: '名字', avatar_template: 'https://cdn.example/{size}.png' } } : { email: ' A@EXAMPLE.COM ' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address')
    const identity = await readIdentity((url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init), 'fixed-key', 'fixed-client', new AbortController().signal)
    expect(identity).toEqual({ id: '10', username: '名字', avatarUrl: 'https://cdn.example/512.png', email: 'a@example.com' })
    expect(received).toEqual([{ path: '/session/current.json', key: 'fixed-key', client: 'fixed-client' }, { path: '/u/%E5%90%8D%E5%AD%97/emails.json', key: 'fixed-key', client: 'fixed-client' }])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it.each([
  [{ id: 0 }, 'CFX_USER_INVALID'], [{ id: Number.MAX_SAFE_INTEGER + 1 }, 'CFX_USER_INVALID'],
  [{ username: ' member' }, 'CFX_USER_INVALID'], [{ username: 'a\u0000' }, 'CFX_USER_INVALID'],
  [{ username: '\ud800' }, 'CFX_USER_INVALID'],
  [{ username: '😀'.repeat(129) }, 'CFX_USER_INVALID'],
  [{ avatar_template: 'http://cdn.example/{size}' }, 'CFX_USER_INVALID'],
  [{ avatar_template: 'https://user:secret@cdn.example/{size}' }, 'CFX_USER_INVALID'],
  [{ avatar_template: '/avatar/{unknown}' }, 'CFX_USER_INVALID'], [{ avatar_template: '/avatar#fragment' }, 'CFX_USER_INVALID'],
])('rejects incomplete or unsafe session identity %j', async (changes, code) => {
  let calls = 0
  await expect(readIdentity(async () => { calls++; return Response.json({ current_user: { id: 1, username: 'Member', avatar_template: '/{size}', ...changes } }) }, 'key', 'client', new AbortController().signal)).rejects.toMatchObject({ code })
  expect(calls).toBe(1)
})

it.each([
  [302, 'application/json', '{}', 'CFX_UPSTREAM_UNAVAILABLE'],
  [401, 'application/json', '{}', 'CFX_UPSTREAM_UNAVAILABLE'],
  [403, 'application/json', '{}', 'CFX_UPSTREAM_UNAVAILABLE'],
  [200, 'text/html', '{}', 'CFX_UPSTREAM_UNAVAILABLE'],
  [200, 'application/json', 'not-json', 'CFX_UPSTREAM_UNAVAILABLE'],
  [200, 'application/json', ' '.repeat(1024 * 1024 + 1), 'CFX_UPSTREAM_UNAVAILABLE'],
])('rejects upstream protocol failures %s %s', async (status, contentType, body, code) => {
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual')
    return new Response(body, { status, headers: { 'Content-Type': contentType, Location: 'https://evil.example' } })
  })
  await expect(readIdentity(transport, 'key', 'client', new AbortController().signal)).rejects.toMatchObject({ code })
  expect(transport).toHaveBeenCalledTimes(1)
})

it.each([Response.json({ email: '' }), Response.json({ email: 'bad' }), Response.json({}, { status: 403 }), Response.json({}, { status: 401 })])('rejects unavailable main email', async emailResponse => {
  await expect(readIdentity(async url => url.includes('/session/') ? Response.json({ current_user: { id: 1, username: 'Member', avatar_template: '/{size}' } }) : emailResponse, 'key', 'client', new AbortController().signal)).rejects.toMatchObject({ code: 'CFX_EMAIL_UNAVAILABLE' })
})

it('aborts and cancels a slow body at the individual request deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const result = readIdentity(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }), 'key', 'client', new AbortController().signal).catch(error => error)
  await vi.advanceTimersByTimeAsync(20000)
  expect(await result).toMatchObject({ code: 'CFX_UPSTREAM_TIMEOUT' })
  expect(cancelled).toBe(true)
})

it('bounds counter cardinality and all operation budgets with fixed-window recovery', () => {
  const limiter = new CfxRateLimiter()
  for (let i = 0; i < 2048; i++) limiter.check('inspect', 'ip', `ip-${i}`, 0)
  expect(() => limiter.check('inspect', 'ip', 'overflow', 0)).toThrow(expect.objectContaining({ code: 'CFX_CAPACITY_EXCEEDED' }))
  limiter.check('inspect', 'ip', 'overflow', 60000)
  for (const [kind, ipBudget, bindingBudget] of [['create', 10, 6], ['complete', 30, 6], ['inspect', 120, 60], ['cancel', 30, 10]] as const) {
    for (const [scope, count] of [['ip', ipBudget], ['binding', bindingBudget]] as const) {
      const limited = new CfxRateLimiter()
      for (let i = 0; i < count; i++) limited.check(kind, scope, 'same', 0)
      expect(() => limited.check(kind, scope, 'same', 1000)).toThrow(expect.objectContaining({ code: 'CFX_REQUEST_LIMITED', retryAfterSeconds: 59 }))
      limited.check(kind, scope, 'same', 60000)
    }
  }
})
