import { afterEach, expect, it } from 'vitest'
import Fastify from '../../apps/server/node_modules/fastify/fastify.js'
import type { FastifyRequest } from '../../apps/server/node_modules/fastify'
import fp from '../../apps/server/node_modules/fastify-plugin'
import glue from '../../apps/server/node_modules/fastify-openapi-glue/index.js'
import { fixture } from '../registration/fixture'
import { registerErrorHandlers } from '@server/src/errors'
import { authenticateBearer } from '@server/src/modules/auth/api/security'
import registrationPlugin from '@server/src/modules/registration/plugin'
import linksPlugin from '@server/src/modules/identity-links/plugin'
import externalAccountsPlugin from '@server/src/modules/external-accounts/plugin'
import registrationApi from '@server/src/modules/registration/api/plugin'
import linksApi from '@server/src/modules/identity-links/api/plugin'
import { operations as registrationOperations } from '@server/src/modules/registration/api/operations'
import { operations as linkOperations } from '@server/src/modules/identity-links/api/operations'
import { compileComponentSchema, readContract } from '../helpers/contract'
import type { OperationId, TypedApiHandler } from '@server/src/http/handler-types'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function appFixture(disabled = true, production = false) {
  const f = await fixture({ disabled })
  cleanup.push(() => f.close())
  const app = Fastify()
  cleanup.push(() => app.close())
  registerErrorHandlers(app)
  await app.register(
    fp(
      async (app) => {
        app.decorate('authServices', f.auth)
        app.decorateRequest('authSession', undefined)
      },
      { name: 'business-auth' },
    ),
  )
  await app.register(
    fp(
      async (app) => {
        app.decorate('cfxServices', f.cfx)
      },
      { name: 'business-cfx' },
    ),
  )
  await app.register(externalAccountsPlugin, { externalAccountServices: f.links.externalAccounts })
  await app.register(linksPlugin, { identityLinkServices: f.links })
  await app.register(registrationPlugin, { registrationServices: f.registration })
  const origin = production ? 'https://website.example' : 'http://127.0.0.1:8080'
  await app.register(registrationApi, { publicOrigin: origin, production })
  await app.register(linksApi, { publicOrigin: origin, production })
  const raw: Array<unknown> = []
  const getMyIdentityLinks: typeof linkOperations.getMyIdentityLinks = async (request) => {
    const result = await linkOperations.getMyIdentityLinks(request)
    raw.push(result)
    return result
  }
  function capture<Id extends OperationId>(
    schema: string,
    handler: TypedApiHandler<Id>,
  ): TypedApiHandler<Id> {
    return async (request, reply) => {
      const result = await handler(request, reply)
      expect(compileComponentSchema(schema)(result), `Raw handler must satisfy ${schema}`).toBe(true)
      return result
    }
  }
  const handlers = {
    requestRegistrationCode: capture<'requestRegistrationCode'>(
      'RegistrationCodeRequested',
      registrationOperations.requestRegistrationCode,
    ),
    verifyRegistrationCode: capture<'verifyRegistrationCode'>(
      'RegistrationGrant',
      registrationOperations.verifyRegistrationCode,
    ),
    completePublicRegistration: capture<'completePublicRegistration'>(
      'RegistrationResult',
      registrationOperations.completePublicRegistration,
    ),
    signInWithCfx: capture<'signInWithCfx'>('CfxSignInResult', registrationOperations.signInWithCfx),
    getMyIdentityLinks: capture<'getMyIdentityLinks'>('IdentityLinksResponse', getMyIdentityLinks),
    createMyCfxLinkAttempt: capture<'createMyCfxLinkAttempt'>(
      'CfxAttemptCreated',
      linkOperations.createMyCfxLinkAttempt,
    ),
    linkMyCfxIdentity: capture<'linkMyCfxIdentity'>('IdentityLink', linkOperations.linkMyCfxIdentity),
    unlinkMyCfxIdentity: capture<'unlinkMyCfxIdentity'>(
      'UnlinkIdentityResult',
      linkOperations.unlinkMyCfxIdentity,
    ),
  }
  const document = readContract(),
    paths = Object.fromEntries(
      Object.entries(document.paths).filter(([, path]) =>
        Object.values(path).some(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            'operationId' in value &&
            typeof value.operationId === 'string' &&
            value.operationId in handlers,
        ),
      ),
    )
  await app.register(glue, {
    specification: { ...document, paths },
    prefix: '/api',
    serviceHandlers: handlers,
    securityHandlers: { bearerAuth: async (request: FastifyRequest) => authenticateBearer(request, f.auth) },
  })
  await app.ready()
  return { ...f, app, origin, raw }
}
it('enforces browser origin, duplicate cookies, missing binding, JSON and size before issuing email grants', async () => {
  const f = await appFixture()
  for (const headers of [
    {},
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: f.origin, 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/registration/code',
      headers,
      payload: { email: 'new@example.com' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.headers['cache-control']).toBe('no-store')
  }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/auth/registration/code?x=1',
        headers: { origin: f.origin },
        payload: { email: 'new@example.com' },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/auth/registration/code',
        headers: { origin: f.origin, 'content-type': 'text/plain' },
        payload: 'text',
      })
    ).statusCode,
  ).toBe(415)
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/auth/registration/code',
        headers: { origin: f.origin },
        payload: { email: 'x'.repeat(5000) },
      })
    ).statusCode,
  ).toBe(413)
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/auth/registration/code',
    headers: { origin: f.origin },
    payload: { email: 'new@example.com' },
  })
  expect(sent.statusCode).toBe(202)
  expect(compileComponentSchema('RegistrationCodeRequested')(sent.json())).toBe(true)
  const cookie = String(sent.headers['set-cookie']).split(';')[0]!
  expect(String(sent.headers['set-cookie'])).toContain('Max-Age=2400')
  expect(sent.headers['referrer-policy']).toBe('no-referrer')
  expect(sent.headers['x-content-type-options']).toBe('nosniff')
  const payload = { challengeId: sent.json().challengeId, code: f.mail[0]!.code }
  for (const badCookie of [undefined, `${cookie}; ${cookie}`, 'exwebsite.registration.browser=invalid']) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/auth/registration/verify',
      headers: { origin: f.origin, ...(badCookie ? { cookie: badCookie } : {}) },
      payload,
    })
    expect([400, 410]).toContain(response.statusCode)
  }
  const verified = await f.app.inject({
    method: 'POST',
    url: '/api/auth/registration/verify',
    headers: { origin: f.origin, cookie },
    payload,
  })
  expect(verified.statusCode).toBe(200)
  expect(compileComponentSchema('RegistrationGrant')(verified.json())).toBe(true)
  expect(String(verified.headers['set-cookie']).split(';')[0]).toBe(cookie)
  const complete = {
    registrationToken: verified.json().registrationToken,
    nickname: 'Member',
    password: 'password123',
  }
  const first = await f.app.inject({
    method: 'POST',
    url: '/api/auth/registrations',
    headers: { origin: f.origin, cookie },
    payload: complete,
  })
  expect(first.statusCode).toBe(201)
  expect(compileComponentSchema('RegistrationResult')(first.json())).toBe(true)
  const repeat = await f.app.inject({
    method: 'POST',
    url: '/api/auth/registrations',
    headers: { origin: f.origin, cookie },
    payload: complete,
  })
  expect(repeat.statusCode).toBe(200)
  expect(repeat.json()).toEqual(first.json())
})
it('returns cfx/google/qq in that exact raw-handler and HTTP order with Cfx disabled, allowing unlink without Cfx cookies', async () => {
  const f = await appFixture(),
    { login, user } = await f.user()
  await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'Existing', email: 'cfx@example.com' }, user.id),
  )
  const headers = { authorization: `Bearer ${login.token}` }
  const response = await f.app.inject({ method: 'GET', url: '/api/auth/me/identity-links', headers })
  expect(response.statusCode).toBe(200)
  expect(response.json().providers.map((entry: { provider: string }) => entry.provider)).toEqual([
    'cfx',
    'google',
    'qq',
  ])
  expect(f.raw).toEqual([response.json()])
  expect(compileComponentSchema('IdentityLinksResponse')(f.raw[0])).toBe(true)
  expect(response.json().providers[0]).toMatchObject({ available: false, link: { externalUserId: '123' } })
  expect(
    (
      await f.app.inject({
        method: 'DELETE',
        url: '/api/auth/me/identity-links/cfx',
        headers: { ...headers, origin: f.origin, cookie: 'irrelevant=1' },
      })
    ).json(),
  ).toEqual({ status: 'unlinked' })
  expect((await f.app.inject({ method: 'GET', url: '/api/auth/me/identity-links' })).statusCode).toBe(401)
})
it('rejects unsafe Cfx sign-in before real proof consumption and sets an independent registration cookie only on grant', async () => {
  const f = await appFixture(false),
    proof = await f.ready(),
    cookie = `exwebsite.cfx.browser=${proof.begun.cookieValue}`
  const payload = { identityTicket: proof.ticket }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/auth/cfx/sign-in',
        headers: { cookie, origin: 'https://evil.example' },
        payload,
      })
    ).statusCode,
  ).toBe(403)
  expect(f.cfx.inspect(proof.context, proof.attemptId).state).toBe('ready')
  const signed = await f.app.inject({
    method: 'POST',
    url: '/api/auth/cfx/sign-in',
    headers: { cookie, origin: f.origin },
    payload,
  })
  expect(signed.statusCode).toBe(200)
  expect(signed.json().kind).toBe('registration-required')
  expect(compileComponentSchema('CfxSignInResult')(signed.json())).toBe(true)
  expect(String(signed.headers['set-cookie'])).toMatch(/^exwebsite.registration.browser=/)
  expect(String(signed.headers['set-cookie'])).not.toContain(proof.begun.cookieValue)
  expect(f.cfx.inspect(proof.context, proof.attemptId).state).toBe('consumed')
})
it('uses a Secure __Host registration cookie in production with Cfx disabled', async () => {
  const f = await appFixture(true, true)
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/registration/code',
    headers: { origin: f.origin },
    payload: { email: 'prod@example.com' },
  })
  expect(response.statusCode).toBe(202)
  expect(String(response.headers['set-cookie'])).toMatch(/^__Host-exwebsite.registration.browser=/)
  expect(String(response.headers['set-cookie'])).toContain('; Secure')
})
it('rejects Cfx mutation query/body/source errors without consuming a real link intent', async () => {
  const f = await appFixture(false),
    { login } = await f.user(),
    authorization = `Bearer ${login.token}`
  const begun = await f.app.inject({
    method: 'POST',
    url: '/api/auth/me/identity-links/cfx/attempts',
    headers: { origin: f.origin, authorization },
    payload: {},
  })
  expect(begun.statusCode).toBe(201)
  const cookie = String(begun.headers['set-cookie']).split(';')[0]!,
    value = cookie.slice(cookie.indexOf('=') + 1)
  const proof = await f.ready({ response: begun.json(), cookieValue: value }),
    payload = { attemptId: proof.attemptId, identityTicket: proof.ticket }
  for (const headers of [
    { authorization, cookie },
    { authorization, cookie, origin: 'null' },
    { authorization, cookie, origin: f.origin, 'sec-fetch-site': 'cross-site' },
  ]) {
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/auth/me/identity-links/cfx', headers, payload }))
        .statusCode,
    ).toBe(403)
    expect(f.cfx.inspect(proof.context, proof.attemptId).state).toBe('ready')
  }
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/auth/me/identity-links/cfx',
        headers: { authorization, cookie: `${cookie}; ${cookie}`, origin: f.origin },
        payload,
      })
    ).statusCode,
  ).toBe(400)
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/me/identity-links/cfx',
    headers: { authorization, cookie, origin: f.origin },
    payload,
  })
  expect(response.statusCode).toBe(201)
  expect(compileComponentSchema('IdentityLink')(response.json())).toBe(true)
  for (const url of ['/api/auth/me/identity-links?unknown=1', '/api/auth/me/identity-links/cfx?unknown=1']) {
    expect(
      (
        await f.app.inject({
          method: url.includes('/cfx') ? 'DELETE' : 'GET',
          url,
          headers: { authorization, origin: f.origin },
        })
      ).statusCode,
    ).toBe(400)
  }
  expect(
    (
      await f.app.inject({
        method: 'DELETE',
        url: '/api/auth/me/identity-links/cfx',
        headers: { authorization, origin: f.origin },
        payload: {},
      })
    ).statusCode,
  ).toBe(400)
})

it('includes Retry-After on disabled Cfx sign-in and identity-link mutation responses', async () => {
  const f = await appFixture(),
    { login } = await f.user()
  for (const [url, payload] of [
    ['/api/auth/cfx/sign-in', { identityTicket: 'A'.repeat(43) }],
    ['/api/auth/me/identity-links/cfx/attempts', {}],
    ['/api/auth/me/identity-links/cfx', { attemptId: 'A'.repeat(43), identityTicket: 'A'.repeat(43) }],
  ] as const) {
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: { origin: f.origin, authorization: `Bearer ${login.token}` },
      payload,
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('CFX_DISABLED')
    expect(response.headers['retry-after']).toBe('60')
  }
})

it('includes Retry-After when shared Cfx browser capacity refuses a new owner link attempt', async () => {
  const f = await appFixture(false),
    { login } = await f.user()
  const first = await f.cfx.begin({ clientIp: '127.0.0.1' })
  for (let i = 0; i < 2; i++) await f.cfx.begin({ clientIp: '127.0.0.1', bindingToken: first.cookieValue })
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/me/identity-links/cfx/attempts',
    headers: {
      origin: f.origin,
      authorization: `Bearer ${login.token}`,
      cookie: `exwebsite.cfx.browser=${first.cookieValue}`,
    },
    payload: {},
  })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('CFX_CAPACITY_EXCEEDED')
  expect(response.headers['retry-after']).toBe('60')
})

it('includes Retry-After when the shared Cfx service has closed', async () => {
  const f = await appFixture(false),
    { login } = await f.user()
  await f.cfx.close()
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/me/identity-links/cfx/attempts',
    headers: { origin: f.origin, authorization: `Bearer ${login.token}` },
    payload: {},
  })
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('CFX_SERVICE_CLOSED')
  expect(response.headers['retry-after']).toBe('60')
})

it('serializes the signed-in Cfx union with a real session and no registration cookie', async () => {
  const f = await appFixture(false),
    { user } = await f.user()
  await f.db.transaction((tx) =>
    f.links.createInside(tx, { id: '123', username: 'Existing', email: 'old@example.com' }, user.id),
  )
  const proof = await f.ready()
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/cfx/sign-in',
    headers: { origin: f.origin, cookie: `exwebsite.cfx.browser=${proof.begun.cookieValue}` },
    payload: { identityTicket: proof.ticket },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().kind).toBe('signed-in')
  expect(compileComponentSchema('CfxSignInResult')(response.json())).toBe(true)
  expect((await f.auth.authenticateToken(response.json().token)).userId).toBe(user.id)
  expect(response.headers['set-cookie']).toBeUndefined()
  expect((await f.db.query('SELECT * FROM auth_registration_grants')).rows).toHaveLength(0)
})

it('serializes account-exists guidance without creating a link, grant, or registration cookie', async () => {
  const f = await appFixture(false)
  await f.user('cfx@example.com')
  const proof = await f.ready()
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/cfx/sign-in',
    headers: { origin: f.origin, cookie: `exwebsite.cfx.browser=${proof.begun.cookieValue}` },
    payload: { identityTicket: proof.ticket },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({
    kind: 'account-exists',
    email: 'cfx@example.com',
    nextAction: 'login_then_link',
  })
  expect(compileComponentSchema('CfxSignInResult')(response.json())).toBe(true)
  expect(response.headers['set-cookie']).toBeUndefined()
  expect((await f.db.query('SELECT * FROM auth_registration_grants')).rows).toHaveLength(0)
  expect((await f.db.query('SELECT * FROM auth_identity_links')).rows).toHaveLength(0)
})
