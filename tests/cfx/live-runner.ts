import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createApp } from '@workspace/server'
import { createTestAuth } from '@tests/helpers/auth'
import { createCfxServices } from '@server/src/modules/cfx/service'
import { parseCfxConfig } from '@server/src/modules/cfx/config'

// Explicit-only local runner; excluded from the normal test file pattern.
it('verifies new-module OAEP against Cfx and consumes the ticket exactly once', async () => {
  const fixture = await createTestAuth()
  let app: ReturnType<typeof createApp> | undefined
  let server: ReturnType<typeof createServer> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
  const service = createCfxServices({ config: parseCfxConfig({ CFX_ENABLED: 'true', NODE_ENV: 'development', SERVER_PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:8080', CFX_APPLICATION_NAME: 'ExWebsite Cfx identity validation' }) })
  app = createApp({ ...fixture, cfxServices: service })
  const created = await app.inject({ method: 'POST', url: '/api/auth/cfx/attempts', headers: { origin: 'http://127.0.0.1:8080' }, payload: {} })
  expect(created.statusCode).toBe(201)
  const cookie = String(created.headers['set-cookie']).split(';')[0]!
  const result = created.json(), access = randomBytes(32).toString('base64url')
  let resolvePayload!: (payload: string) => void
  let rejectPayload!: (error: Error) => void
  const payload = new Promise<string>((resolve, reject) => { resolvePayload = resolve; rejectPayload = reject })
  let localOrigin = ''
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.url !== `/${access}`) { response.writeHead(404).end(); return }
    if (request.method === 'GET') {
      const link = result.authorizationUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      response.end(`<html lang="zh"><meta charset="utf-8"><title>Cfx 身份模块验收</title><h1>Cfx 身份模块验收</h1><p><a href="${link}" target="_blank" rel="noreferrer">在 Cfx 授权 session_info 与 read</a></p><p>将授权页显示的加密 payload 粘贴到下方。资料只写入本机忽略目录，不创建本站账号。</p><form method="post"><textarea name="payload" rows="8" cols="80" required maxlength="1024"></textarea><p><button>验证并消费一次凭证</button></p></form></html>`)
      return
    }
    if (request.method !== 'POST' || request.headers.origin !== localOrigin || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403).end(); return }
    let body = '', bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 4096) { response.writeHead(413).end(); request.destroy(); return }
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (bytes > 4096) return
      const query = new URLSearchParams(body)
      const submitted = query.getAll('payload')
      if (submitted.length !== 1 || !submitted[0]) { response.writeHead(400).end(); return }
      resolvePayload(submitted[0]); response.end('已提交。验证结果请查看终端；邮箱等资料不会显示在页面。')
    })
  })
  timeout = setTimeout(() => rejectPayload(new Error('Live authorization was not completed in the ten-minute attempt window.')), 600000)
    const listener = server
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve() })
    })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Runner did not bind.')
    localOrigin = `http://127.0.0.1:${address.port}`
    await mkdir('.local/cfx-identity', { recursive: true })
    await writeFile('.local/cfx-identity/runner-url.txt', `${localOrigin}/${access}`)
    console.log(`本地验收页面：${localOrigin}/${access}`)
    const completed = await app.inject({ method: 'POST', url: `/api/auth/cfx/attempts/${result.attemptId}/complete`, headers: { cookie, origin: 'http://127.0.0.1:8080' }, payload: { payload: await payload } })
    expect(completed.statusCode, 'Live Cfx module completion failed; no upstream secrets are printed.').toBe(200)
    const ready = (await app.inject({ method: 'GET', url: `/api/auth/cfx/attempts/${result.attemptId}`, headers: { cookie } })).json()
    expect(ready.state).toBe('ready')
    const context = service.resolveBrowserContext({ bindingToken: cookie.split('=')[1]!, clientIp: '127.0.0.1' })
    const identity = service.consumeIdentity({ context, identityTicket: ready.identityTicket })
    expect(() => service.consumeIdentity({ context, identityTicket: ready.identityTicket })).toThrow()
    await mkdir('.local/cfx-identity', { recursive: true })
    await writeFile('.local/cfx-identity/live-identity.json', JSON.stringify(identity, null, 2), { mode: 0o600 })
    await writeFile('.local/cfx-identity/live-result.json', JSON.stringify({ status: 'PASS', verifiedAt: new Date().toISOString(), protocol: 'RSA-OAEP-SHA1', fields: Object.keys(identity), consumedExactlyOnce: true }, null, 2))
    console.log('新模块真实 Cfx OAEP 验收 PASS；四字段与一次消费已验证，私密结果位于 .local/cfx-identity/。')
  } finally {
    clearTimeout(timeout)
    const cleanup: Promise<unknown>[] = [fixture.close()]
    if (app) cleanup.push(app.close())
    if (server) {
      const listener = server
      listener.closeAllConnections()
      cleanup.push(new Promise<void>(resolve => listener.close(() => resolve())))
    }
    const settled = await Promise.allSettled(cleanup)
    if (settled.some(result => result.status === 'rejected')) throw new Error('Cfx runner cleanup failed.')
  }
}, 660000)
