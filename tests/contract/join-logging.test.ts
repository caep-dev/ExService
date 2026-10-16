import { Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '@workspace/server'
import { createTestAuth, type TestAuth } from '../helpers/auth'
const fixtures: TestAuth[] = [],
  apps: Array<ReturnType<typeof createApp>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(fixtures.splice(0).map((f) => f.close()))
})
it('keeps registration credentials and original exception stacks out of actual HTTP request/error logs', async () => {
  const password = 'PASSWORD_SECRET_LOG_93821',
    hmac = '07'.repeat(32),
    stackMarker = 'PRIVATE_PROVIDER_STACK_FRAME_93821'
  let registrationToken = '',
    code = ''
  const f = await createTestAuth({
    passwordHasher: {
      verify: async () => true,
      hash: async () => {
        const error = new Error(`${password} ${code} ${registrationToken} ${hmac}`)
        error.stack = `${stackMarker}\n${error.message}`
        throw error
      },
    },
  })
  fixtures.push(f)
  const chunks: string[] = [],
    stream = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString())
        done()
      },
    })
  const app = createApp({ ...f, logger: { level: 'info', stream } })
  apps.push(app)
  const requested = await app.inject({
    method: 'POST',
    url: '/api/auth/registration/code',
    headers: { origin: f.publicOrigin },
    payload: { email: 'new@example.com' },
  })
  expect(requested.statusCode, requested.body).toBe(202)
  const cookie = String(requested.headers['set-cookie']).split(';')[0]!,
    headers = { origin: f.publicOrigin, cookie }
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1))
  code = f.deliveries[0]!.code
  const payload = { challengeId: requested.json().challengeId, code }
  const verified = await app.inject({
    method: 'POST',
    url: '/api/auth/registration/verify',
    headers,
    payload,
  })
  expect(verified.statusCode, verified.body).toBe(200)
  registrationToken = verified.json().registrationToken
  expect(registrationToken).toHaveLength(43)
  await f.db.query(
    'INSERT INTO auth_users(id,email,nickname,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',
    [
      '10000000-0000-4000-8000-000000000001',
      'existing@example.com',
      'Existing',
      'fixture-hash',
      f.now(),
    ],
  )
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'existing@example.com', password },
      })
    ).statusCode,
  ).toBe(200)
  const bad = await app.inject({
    method: 'POST',
    url: '/api/auth/registration/verify',
    headers,
    payload,
  })
  expect(bad.statusCode).toBe(400)
  const failure = await app.inject({
    method: 'POST',
    url: '/api/auth/registrations',
    headers,
    payload: { registrationToken, nickname: 'Final', password },
  })
  expect(failure.statusCode).toBe(500)
  const logs = chunks.join('')
  for (const secret of [password, code, registrationToken, hmac, stackMarker])
    expect(logs).not.toContain(secret)
  const records = chunks.flatMap((chunk) =>
    chunk
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  )
  expect(records.filter((record) => record.msg === 'incoming request')).toHaveLength(5)
  expect(records.find((record) => record.msg === 'request rejected')).toMatchObject({
    code: 'REGISTRATION_CODE_INVALID',
    statusCode: 400,
    reqId: bad.json().error.requestId,
  })
  expect(records.find((record) => record.msg === 'request failed')).toMatchObject({
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    reqId: failure.json().error.requestId,
  })
  expect(records.some((record) => 'err' in record || 'stack' in record)).toBe(false)
})
