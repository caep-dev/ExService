import { afterEach, expect, it } from 'vitest'
import { createApp, serviceHandlers } from '@workspace/server'
import { createTestAuth, type TestAuth } from '@tests/helpers/auth'
import { OidcService } from '@server/src/modules/identity/oidc'

const fixtures: TestAuth[] = []
const apps: Array<ReturnType<typeof createApp>> = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

it('requires mapped internal keys and returns the exact linked-session contract', async () => {
  const fixture = await createTestAuth()
  fixtures.push(fixture)
  const app = createApp({ ...fixture,
    authServices: fixture.authServices, profileServices: fixture.profileServices, storageServices: fixture.storageServices,
    notifications: fixture.notifications, clickupServices: fixture.clickupServices, supportServices: fixture.supportServices,
    identityKeys: { clients: { 'another-app': 'app-secret', other: 'other-secret' }, bootstrapKey: 'bootstrap-secret' } })
  apps.push(app)
  const userId = await fixture.seedUser({ email: 'identity@example.com', nickname: 'Identity', password: 'valid password' })
  const login = await fixture.authServices.login({ email: 'identity@example.com', password: 'valid password' })
  const session = await fixture.authServices.authenticateToken(login.token)
  await fixture.db.query(`INSERT INTO auth_oidc_bindings (client_id, hydra_sid, session_id, user_id, created_at)
    VALUES ('another-app', 'sid-one', $1, $2, $3)`, [session.id, userId, fixture.now()])
  const payload = { hydraSid: 'sid-one', subject: userId }
  const url = '/api/internal/identity/session/check'
  const unauthorized = await app.inject({ method: 'POST', url, payload })
  expect(unauthorized.statusCode).toBe(401)
  expect(unauthorized.headers['cache-control']).toBe('no-store')
  const wrongClient = await app.inject({ method: 'POST', url, headers: { 'x-integration-key': 'other-secret' }, payload })
  expect(wrongClient.statusCode).toBe(200)
  expect(wrongClient.json()).toEqual({ active: false, reason: 'unknown' })
  const active = await app.inject({ method: 'POST', url, headers: { 'x-integration-key': 'app-secret' }, payload })
  expect(active.statusCode, active.body).toBe(200)
  expect(active.json()).toMatchObject({ active: true, sessionId: session.id, userId,
    profile: { nickname: 'Identity', email: 'identity@example.com', version: 0 } })
  const raw = await serviceHandlers.checkLinkedSession({ identityClientId: 'another-app', body: payload,
    server: { authServices: fixture.authServices } } as Parameters<typeof serviceHandlers.checkLinkedSession>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.checkLinkedSession>[1])
  expect(raw).toEqual(active.json())
  const profile = await app.inject({ method: 'POST', url: '/api/internal/identity/user/inspect',
    headers: { 'x-bootstrap-key': 'bootstrap-secret' }, payload: { userId } })
  expect(profile.statusCode, profile.body).toBe(200)
  expect(profile.json()).toMatchObject({ id: userId, profileVersion: 0 })
  const rawProfile = await serviceHandlers.inspectIdentityUser({ body: { userId },
    server: { authServices: fixture.authServices } } as Parameters<typeof serviceHandlers.inspectIdentityUser>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.inspectIdentityUser>[1])
  expect(rawProfile).toEqual(profile.json())

  const revokePayload = { hydraSid: 'sid-one', subject: userId, requestId: '11111111-1111-4111-8111-111111111111' }
  const revoked = await app.inject({ method: 'POST', url: '/api/internal/identity/session/revoke',
    headers: { 'x-integration-key': 'app-secret' }, payload: revokePayload })
  expect(revoked.statusCode, revoked.body).toBe(200)
  expect(revoked.json()).toEqual({ revoked: true })
  const rawRevoke = await serviceHandlers.revokeLinkedSession({ identityClientId: 'another-app', body: revokePayload,
    server: { authServices: fixture.authServices } } as Parameters<typeof serviceHandlers.revokeLinkedSession>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.revokeLinkedSession>[1])
  expect(rawRevoke).toEqual(revoked.json())
  const afterRevoke = await app.inject({ method: 'POST', url,
    headers: { 'x-integration-key': 'app-secret' }, payload })
  expect(afterRevoke.json()).toEqual({ active: false, reason: 'revoked' })
})

it('routes the OIDC browser operations through the generated contract shape', async () => {
  const fixture = await createTestAuth()
  fixtures.push(fixture)
  const userId = await fixture.seedUser({ email: 'browser@example.com', nickname: 'Browser', password: 'valid password' })
  const { token } = await fixture.authServices.login({ email: 'browser@example.com', password: 'valid password' })
  const session = await fixture.authServices.authenticateToken(token)
  const client = { client_id: 'another-app', redirect_uris: ['http://127.0.0.1:9000/callback'] }
  const admin = {
    getLogin: async () => ({ challenge: 'a', client, requested_scope: ['openid'], session_id: 'sid',
      subject: '', skip: false, request_url: 'http://identity.exwebsite.test:8090/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A9000%2Fcallback' }),
    acceptLogin: async () => ({ redirect_to: 'http://identity.exwebsite.test:8090/oauth2/auth?login_verifier=one' }),
    getConsent: async () => ({ challenge: 'b', client, requested_scope: ['openid'], login_session_id: 'sid',
      // Hydra v2.3 returns its internal login request ID here, not the
      // signed browser login_challenge previously submitted to Website.
      login_challenge: 'hydra-internal-login-request-id', subject: userId,
      request_url: 'http://identity.exwebsite.test:8090/oauth2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A9000%2Fcallback' }),
    acceptConsent: async () => ({ redirect_to: 'http://identity.exwebsite.test:8090/oauth2/auth?consent_verifier=one' }),
    getLogout: async () => ({ sid: 'sid', subject: userId, client }),
    acceptLogout: async () => ({ redirect_to: 'http://identity.exwebsite.test:8090/oauth2/sessions/logout?verifier=one' }),
  }
  const oidcServices = new OidcService({ db: fixture.db, authServices: fixture.authServices, admin,
    issuer: 'http://identity.exwebsite.test:8090/', flowKey: Buffer.alloc(32, 7), now: fixture.now,
    clients: { 'another-app': { name: 'Test App', redirectUri: client.redirect_uris[0]!, scopes: ['openid'] } } })
  const app = createApp({ ...fixture, oidcServices })
  apps.push(app)
  const inspect = await app.inject({ method: 'POST', url: '/api/auth/oidc/inspect', payload: { phase: 'login', challenge: 'a' } })
  expect(inspect.statusCode, inspect.body).toBe(200)
  expect(inspect.json()).toEqual({ clientName: 'Test App', scopes: ['openid'] })
  const rawInspect = await serviceHandlers.inspectOidcRequest({ body: { phase: 'login', challenge: 'a' },
    server: { oidcServices } } as Parameters<typeof serviceHandlers.inspectOidcRequest>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.inspectOidcRequest>[1])
  expect(rawInspect).toEqual(inspect.json())
  const longChallenge = await app.inject({ method: 'POST', url: '/api/auth/oidc/inspect',
    payload: { phase: 'login', challenge: 'a'.repeat(8192) } })
  expect(longChallenge.statusCode, longChallenge.body).toBe(200)
  for (const challenge of ['a'.repeat(8193), 'bad challenge', '']) {
    const invalid = await app.inject({ method: 'POST', url: '/api/auth/oidc/inspect',
      payload: { phase: 'login', challenge } })
    expect(invalid.statusCode).toBe(400)
  }
  const headers = { authorization: `Bearer ${token}` }
  const login = await app.inject({ method: 'POST', url: '/api/auth/oidc/login/accept', headers, payload: { challenge: 'a' } })
  expect(login.statusCode, login.body).toBe(200)
  expect(login.json()).toEqual({ redirectUrl: 'http://identity.exwebsite.test:8090/oauth2/auth?login_verifier=one' })
  const consent = await app.inject({ method: 'POST', url: '/api/auth/oidc/consent/accept', headers, payload: { challenge: 'b' } })
  expect(consent.statusCode, consent.body).toBe(200)
  expect(consent.json()).toEqual({ redirectUrl: 'http://identity.exwebsite.test:8090/oauth2/auth?consent_verifier=one' })
  const rawConsent = await serviceHandlers.acceptOidcConsent({ body: { challenge: 'b' }, authSession: session,
    server: { oidcServices } } as Parameters<typeof serviceHandlers.acceptOidcConsent>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.acceptOidcConsent>[1])
  expect(rawConsent).toEqual(consent.json())
  const raw = await serviceHandlers.acceptOidcLogin({ body: { challenge: 'a' }, authSession: session,
    server: { oidcServices } } as Parameters<typeof serviceHandlers.acceptOidcLogin>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.acceptOidcLogin>[1])
  expect(raw).toEqual(login.json())
  const logout = await app.inject({ method: 'POST', url: '/api/auth/oidc/logout/accept', headers, payload: { challenge: 'c' } })
  expect(logout.statusCode, logout.body).toBe(200)
  const logoutBody = logout.json()
  expect(logoutBody).toEqual({ redirectUrl: 'http://identity.exwebsite.test:8090/oauth2/sessions/logout?verifier=one' })
  const rawLogout = await serviceHandlers.acceptOidcLogout({ body: { challenge: 'c' }, authSession: session,
    server: { oidcServices: { acceptLogout: async () => logoutBody } } } as unknown as Parameters<typeof serviceHandlers.acceptOidcLogout>[0],
  { header: () => undefined } as Parameters<typeof serviceHandlers.acceptOidcLogout>[1])
  expect(rawLogout).toEqual(logoutBody)
})
