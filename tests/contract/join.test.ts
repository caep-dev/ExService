import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { FastifyReply } from '../../apps/server/node_modules/fastify'
import { createApp, serviceHandlers } from '@workspace/server'
import {
  createTestAuth,
  joinActor,
  newJoinApplication,
  experiencedJoinApplication,
  joinSnapshot,
} from '../helpers/auth'
import { joinMultipart } from '../helpers/multipart'
import { compileComponentSchema } from '../helpers/contract'
import type { ApiRequest, ApiTransportRequest } from '@server/src/http/handler-types'
import type { JoinTransportBody } from '@server/src/domains/join/api/transport'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const validate = (name: string, result: unknown) => {
  const check = compileComponentSchema(name)
  expect(check(result), JSON.stringify(check.errors)).toBe(true)
}
const reply = {
  header() {
    return this
  },
  code() {
    return this
  },
} as unknown as FastifyReply
async function setup() {
  const f = await createTestAuth()
  cleanup.push(() => f.close())
  const actor = await joinActor(f, 'reviewer@example.com', true)
  const app = createApp({ ...f })
  cleanup.push(() => app.close())
  return { f, actor, app }
}
it('validates all six raw handlers and real authenticated Glue HTTP responses', async () => {
  const { f, actor, app } = await setup(),
    params = { communityId: 'rifling-911' }
  const raw = await serviceHandlers.submitJoinApplication(
    {
      server: f,
      authSession: actor.session,
      params,
      body: { application: experiencedJoinApplication(), proofs: [] },
    } as unknown as ApiTransportRequest<'submitJoinApplication', JoinTransportBody>,
    reply,
  )
  validate('JoinApplicationReceived', raw)
  const id = (await f.db.query<{ id: string }>('SELECT id FROM join_applications')).rows[0]!.id
  const request = {
    server: f,
    authSession: actor.session,
    params: { ...params, applicationId: id },
    query: {},
  }
  const list = await serviceHandlers.listJoinApplications(
    request as unknown as ApiRequest<'listJoinApplications'>,
    reply,
  )
  validate('JoinApplicationList', list)
  const detail = await serviceHandlers.getJoinApplication(
    request as unknown as ApiRequest<'getJoinApplication'>,
    reply,
  )
  validate('JoinApplicationDetail', detail)
  const approved = await serviceHandlers.approveJoinApplication(
    request as unknown as ApiRequest<'approveJoinApplication'>,
    reply,
  )
  validate('JoinApplicationDetail', approved)
  for (const [url, result] of [
    [`/api/admin/communities/rifling-911/applications`, list],
    [`/api/admin/communities/rifling-911/applications/${id}`, approved],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: actor.headers,
    })
    expect(response.statusCode, response.body).toBe(200)
    validate(url.endsWith(id) ? 'JoinApplicationDetail' : 'JoinApplicationList', response.json())
    expect(response.headers['cache-control']).toBe('no-store')
  }
  const replay = await app.inject({
    method: 'POST',
    url: `/api/admin/communities/rifling-911/applications/${id}/approve`,
    headers: actor.headers,
  })
  expect(replay.statusCode, replay.body).toBe(200)
  expect(replay.json()).toEqual(approved)
  const second = await joinActor(f, 'second@example.com'),
    multipart = joinMultipart(newJoinApplication())
  const submit = await app.inject({
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...multipart,
    headers: { ...multipart.headers, ...second.headers },
  })
  expect(submit.statusCode, submit.body).toBe(202)
  validate('JoinApplicationReceived', submit.json())
  const secondId = (
    await f.db.query<{ id: string }>('SELECT id FROM join_applications WHERE user_id=$1', [
      second.id,
    ])
  ).rows[0]!.id
  const rejected = await serviceHandlers.rejectJoinApplication(
    {
      ...request,
      params: { ...params, applicationId: secondId },
    } as unknown as ApiRequest<'rejectJoinApplication'>,
    reply,
  )
  validate('JoinApplicationDetail', rejected)
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/communities/rifling-911/applications/${secondId}/reject`,
    headers: actor.headers,
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toEqual(rejected)
  // Binary raw+HTTP and safe headers have dedicated byte-for-byte coverage in join-upload.test.ts.
})
it('enforces session before multipart parsing, source before writes and live reviewer authorization', async () => {
  const { f, actor, app } = await setup(),
    url = '/api/communities/rifling-911/applications',
    multipart = joinMultipart(newJoinApplication())
  for (const headers of [
    { origin: f.publicOrigin },
    { origin: f.publicOrigin, authorization: 'Bearer invalid' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{broken',
    })
    expect(response.statusCode, response.body).toBe(401)
  }
  for (const origin of [undefined, 'null', 'https://evil.example']) {
    const response = await app.inject({
      method: 'POST',
      url,
      ...multipart,
      headers: {
        ...multipart.headers,
        authorization: actor.authorization,
        ...(origin ? { origin } : {}),
      },
    })
    expect(response.statusCode).toBe(403)
  }
  const accepted = await app.inject({
    method: 'POST',
    url,
    ...multipart,
    headers: { ...multipart.headers, ...actor.headers },
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const id = (await f.db.query<{ id: string }>('SELECT id FROM join_applications')).rows[0]!.id,
    before = await joinSnapshot(f)
  const outsider = await joinActor(f, 'outsider@example.com')
  for (const [method, path] of [
    ['GET', ''],
    ['GET', `/${id}`],
    ['POST', `/${id}/approve`],
    ['POST', `/${id}/reject`],
  ] as const) {
    const response = await app.inject({
      method,
      url: `/api/admin/communities/rifling-911/applications${path}`,
      headers: outsider.headers,
    })
    expect(response.statusCode, response.body).toBe(403)
    validate('ErrorEnvelope', response.json())
  }
  await f.db.query('DELETE FROM community_reviewers WHERE user_id=$1', [actor.id])
  const revoked = await app.inject({
    method: 'POST',
    url: `/api/admin/communities/rifling-911/applications/${id}/approve`,
    headers: actor.headers,
  })
  expect(revoked.statusCode).toBe(403)
  expect((await f.db.query('SELECT status FROM join_applications')).rows).toEqual([
    { status: 'pending' },
  ])
  expect((await f.db.query('SELECT * FROM notification_events')).rows).toEqual([])
})
it('preserves all five strict historical/live schema variants, readonly history and pagination', async () => {
  const { f, actor, app } = await setup(),
    ids: string[] = []
  for (const [index, type] of ['new', 'experienced', 'new', 'experienced'].entries()) {
    const applicant = await joinActor(f, `variant-${index}@example.com`)
    await f.joinServices.submit(
      applicant.session,
      'rifling-911',
      type === 'new' ? newJoinApplication() : experiencedJoinApplication(),
      type === 'experienced'
        ? [
            {
              originalName: 'proof.txt',
              bytes: Buffer.from('historical proof'),
            },
          ]
        : [],
    )
    const id = (
      await f.db.query<{ id: string }>('SELECT id FROM join_applications WHERE user_id=$1', [
        applicant.id,
      ])
    ).rows[0]!.id
    ids.push(id)
    if (index >= 2)
      await f.db.query(
        'UPDATE join_applications SET legacy_read_only=true,user_id=NULL WHERE id=$1',
        [id],
      )
  }
  const legacy = randomUUID()
  ids.push(legacy)
  await f.db.query(
    "INSERT INTO join_applications(id,email,nickname,qq,status,created_at,community_id,legacy_read_only) VALUES($1,'legacy@example.com','Legacy','1','pending',1,'rifling-911',true)",
    [legacy],
  )
  const invitationId = randomUUID(),
    deliveryId = randomUUID()
  await f.db.query(
    "INSERT INTO join_invitations(id,application_id,status,issued_at,expires_at,code_version) VALUES($1,$2,'expired',1,2,1)",
    [invitationId, legacy],
  )
  await f.db.query(
    "INSERT INTO join_delivery_attempts(id,invitation_id,code_version,started_at,finished_at,status) VALUES($1,$2,1,1,2,'failed')",
    [deliveryId, invitationId],
  )
  const historyBefore = await joinSnapshot(f)
  for (const id of ids) {
    const raw = await serviceHandlers.getJoinApplication(
      {
        server: f,
        authSession: actor.session,
        params: { communityId: 'rifling-911', applicationId: id },
      } as unknown as ApiRequest<'getJoinApplication'>,
      reply,
    )
    validate('JoinApplicationDetail', raw)
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/communities/rifling-911/applications/${id}`,
      headers: actor.headers,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual(raw)
    if (id === legacy)
      expect(raw).toMatchObject({
        application: { invitationStatus: 'expired', deliveryStatus: 'failed' },
        invitation: {
          id: invitationId,
          codeExpiresAt: null,
          latestDelivery: { id: deliveryId, status: 'failed' },
        },
      })
    if (raw.application.legacyReadOnly && raw.attachments.length) {
      const download = await app.inject({
        method: 'GET',
        url: `/api/admin/communities/rifling-911/applications/${id}/attachments/${raw.attachments[0]!.id}`,
        headers: actor.headers,
      })
      expect(download.statusCode, download.body).toBe(200)
      expect(download.rawPayload).toEqual(Buffer.from('historical proof'))
    }
    if (raw.application.legacyReadOnly) {
      for (const decision of ['approve', 'reject']) {
        const blocked = await app.inject({
          method: 'POST',
          url: `/api/admin/communities/rifling-911/applications/${id}/${decision}`,
          headers: actor.headers,
        })
        expect(blocked.statusCode, blocked.body).toBe(409)
        expect(blocked.json().error.code).toBe('JOIN_HISTORY_READ_ONLY')
      }
    }
  }
  expect(await joinSnapshot(f)).toEqual(historyBefore)
  for (const [source, total] of [
    ['live', 2],
    ['legacy', 3],
    ['all', 5],
  ] as const) {
    const raw = await serviceHandlers.listJoinApplications(
      {
        server: f,
        authSession: actor.session,
        params: { communityId: 'rifling-911' },
        query: { source, limit: 2, offset: 1 },
      } as unknown as ApiRequest<'listJoinApplications'>,
      reply,
    )
    validate('JoinApplicationList', raw)
    expect(raw.total).toBe(total)
    expect(raw.items).toHaveLength(Math.min(total - 1, 2))
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/communities/rifling-911/applications?source=${source}&limit=2&offset=1`,
      headers: actor.headers,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual(raw)
  }
  expect((await f.db.query('SELECT * FROM notification_events')).rows).toEqual([])
})
it('returns 404 for every retired public/admin invitation and anonymous application route', async () => {
  const { app, actor } = await setup()
  for (const [method, url] of [
    ['POST', '/api/join/applications'],
    ['POST', '/api/join/applications/query'],
    ['GET', '/api/admin/join/applications'],
    ['POST', '/api/admin/join/applications/00000000-0000-4000-8000-000000000001/resend'],
    ...['check', 'request-code', 'verify', 'complete'].map((s) => [
      'POST',
      `/api/auth/invitations/${s}`,
    ]),
  ] as const) {
    const response = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: actor.headers,
    })
    expect(response.statusCode, `${method} ${url}`).toBe(404)
  }
})
