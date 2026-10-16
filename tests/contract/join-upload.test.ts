import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv from 'ajv'
import { readContract } from '@tests/helpers/contract'
import { afterEach, expect, it, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from '../../apps/server/node_modules/fastify'
import { createApp, serviceHandlers } from '@workspace/server'
import { createApiClient } from '@api-client/src/client'
import { createExAxios, ExAxiosError } from '../../packages/sdk/src/http/node'
import {
  joinActor,
  createTestAuth,
  experiencedJoinApplication,
  newJoinApplication,
  joinSnapshot,
  type TestAuth,
} from '@tests/helpers/auth'
import { applicationPart, joinMultipart, multipartBody } from '@tests/helpers/multipart'

const contract = readContract(new URL('../../api/generated/openapi.json', import.meta.url))
const definitions = JSON.parse(
  JSON.stringify(contract.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'),
)
function validate(name: string, value: unknown) {
  const check = new Ajv({ strict: false, allErrors: true }).compile({
    ...definitions[name],
    definitions,
  })
  expect(check(value), JSON.stringify(check.errors)).toBe(true)
}
const fixtures: TestAuth[] = [],
  apps: ReturnType<typeof createApp>[] = []
const childCleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(childCleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(fixtures.splice(0).map((f) => f.close()))
})
let actorCounter = 0
const reviewers = new WeakMap<ReturnType<typeof createApp>, Awaited<ReturnType<typeof joinActor>>>()
async function setup() {
  const f = await createTestAuth()
  fixtures.push(f)
  const actor = await joinActor(f, 'reviewer@example.com', true)
  const app = createApp({ ...f })
  apps.push(app)
  reviewers.set(app, actor)
  return { f, app, actor }
}
async function send(
  f: TestAuth,
  app: ReturnType<typeof createApp>,
  request: import('../../apps/server/node_modules/fastify').InjectOptions,
) {
  const actor =
    request.method === 'GET'
      ? reviewers.get(app)!
      : await joinActor(f, `request-${++actorCounter}@example.com`)
  return app.inject({
    ...request,
    headers: { ...actor.headers, ...request.headers },
  })
}
const wireHeaders = new Map<string, Record<string, string>>()
const proof = (bytes = Buffer.from('review evidence'), filename = '证明.txt') => ({
  filename,
  bytes,
  contentType: 'application/octet-stream',
})
async function liveSetup() {
  const { f, app } = await setup()
  const responses: Array<{ status: number; headers: Record<string, unknown> }> = []
  app.addHook('onResponse', (_request, reply, done) => {
    responses.push({ status: reply.statusCode, headers: reply.getHeaders() })
    done()
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing ephemeral address')
  const baseUrl = `http://127.0.0.1:${address.port}/api`
  const http = createExAxios({
    baseUrl,
    websiteBaseUrl: baseUrl,
    alert: false,
  })
  const client = createApiClient({
    baseUrl,
    transport: async (request) => {
      const actor = await joinActor(f, `client-${++actorCounter}@example.com`)
      return http({
        ...request,
        headers: { ...request.headers, ...actor.headers },
      })
    },
  })
  return { f, app, client, baseUrl, responses }
}
function sendProof(
  client: ReturnType<typeof createApiClient>,
  email: string,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  signal?: AbortSignal,
) {
  const file = new File([Uint8Array.from(bytes)], filename, {
    type: contentType,
  })
  const data = new FormData()
  data.append(
    'application',
    new Blob([JSON.stringify(experiencedJoinApplication(email))], {
      type: 'application/json',
    }),
    'application.json',
  )
  data.append('proofs', file)
  return client.POST('/communities/{communityId}/applications', {
    params: { path: { communityId: 'rifling-911' } },
    signal,
    body: data,
    alert: false,
  })
}

async function sendProofWire(
  baseUrl: string,
  email: string,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  signal?: AbortSignal,
) {
  const data = new FormData()
  data.append(
    'application',
    new Blob([JSON.stringify(experiencedJoinApplication(email))], {
      type: 'application/json',
    }),
    'application.json',
  )
  data.append('proofs', new File([Uint8Array.from(bytes)], filename, { type: contentType }))
  return fetch(`${baseUrl}/communities/rifling-911/applications`, {
    method: 'POST',
    body: data,
    signal,
    headers: wireHeaders.get(baseUrl),
  })
}

async function isolatedLiveClient() {
  const loader = createRequire(new URL('../../apps/server/package.json', import.meta.url)).resolve(
    'tsx',
  )
  const child = fork(fileURLToPath(new URL('../helpers/join-proof-server.ts', import.meta.url)), {
    execArgv: ['--import', pathToFileURL(loader).href],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, EXWEBSITE_PROOF_SERVER_CHILD: '1' },
  })
  let avatarDirectory: string | undefined
  let startupError = ''
  child.stderr?.on('data', (chunk) => {
    startupError = (startupError + String(chunk)).slice(-4000)
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000)
  childCleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const hardStop = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(hardStop)
    clearTimeout(deadline)
    // A forced stop cannot execute the child's normal fixture.close(); only clean its known temporary directory.
    if (avatarDirectory !== undefined) {
      const directory = resolve(avatarDirectory)
      if (
        dirname(directory) !== resolve(tmpdir()) ||
        !basename(directory).startsWith('exwebsite-avatars-')
      )
        throw new Error('Unexpected isolated fixture directory')
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const port = await new Promise<number>((resolvePort, reject) => {
    child.once('error', reject)
    child.once('exit', () =>
      reject(new Error(`Isolated proof server exited before readiness: ${startupError}`)),
    )
    child.once('message', (message) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('port' in message) ||
        typeof message.port !== 'number' ||
        !('avatarDirectory' in message) ||
        typeof message.avatarDirectory !== 'string'
      ) {
        reject(new Error('Invalid isolated server readiness'))
        return
      }
      avatarDirectory = message.avatarDirectory
      if (!('authorization' in message) || typeof message.authorization !== 'string')
        throw new Error('Missing child authorization')
      wireHeaders.set(`http://127.0.0.1:${message.port}/api`, {
        authorization: message.authorization,
        origin: 'http://127.0.0.1:8080',
      })
      resolvePort(message.port)
    })
  })
  const baseUrl = `http://127.0.0.1:${port}/api`
  const http = createExAxios({
    baseUrl,
    websiteBaseUrl: baseUrl,
    alert: false,
  })
  return {
    client: createApiClient({ baseUrl, transport: (request) => http(request) }),
    baseUrl,
  }
}

it('consumes JSON Blob and repeated proof files through the generated Client and actual loopback socket', async () => {
  const { f, client, responses } = await liveSetup()
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 127, 128])
  const unicodeText = '中文证明与😀原始字节'
  for (const [index, application] of [
    newJoinApplication('new-client@example.com'),
    experiencedJoinApplication('experience-client@example.com'),
    experiencedJoinApplication('no-files@example.com'),
  ].entries()) {
    const files =
      index === 1
        ? [
            new File([png], '证明图.png', { type: 'image/png' }),
            new File([unicodeText], '证明文.txt', { type: 'text/plain' }),
          ]
        : []
    const data = new FormData()
    data.append(
      'application',
      new Blob([JSON.stringify(application)], { type: 'application/json' }),
      'application.json',
    )
    files.forEach((file) => data.append('proofs', file))
    const result = await client.POST('/communities/{communityId}/applications', {
      params: { path: { communityId: 'rifling-911' } },
      body: data,
      alert: false,
    })
    expect(responses.at(-1)?.status).toBe(202)
    expect(responses.at(-1)?.headers['cache-control']).toBe('no-store')
    expect(responses.at(-1)?.headers['x-request-id']).toEqual(expect.any(String))
    validate('JoinApplicationReceived', result)
  }
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_forms')).rows[0],
  ).toEqual({ n: 3 })
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_attachments'))
      .rows[0],
  ).toEqual({ n: 2 })
  const stored = (
    await f.db.query<{ original_name: string; bytes: Buffer; sha256: string }>(
      'SELECT original_name,bytes,sha256 FROM join_application_attachments ORDER BY ordinal',
    )
  ).rows
  expect(stored.map((row) => row.original_name)).toEqual(['证明图.png', '证明文.txt'])
  const originals = [Buffer.from(png), Buffer.from(unicodeText)]
  stored.forEach((row, i) => {
    expect(row.bytes).toEqual(originals[i])
    expect(row.sha256).toBe(createHash('sha256').update(originals[i]!).digest('hex'))
  })
})

it('accepts self-closing SVG roots with optional XML declarations through actual multipart HTTP', async () => {
  const { f, client, responses } = await liveSetup()
  for (const [index, content] of ['<svg/>', '<?xml version="1.0"?><svg/>'].entries()) {
    const response = await sendProof(
      client,
      `svg-root-${index}@example.com`,
      Buffer.from(content),
      '图形.svg',
      'image/svg+xml',
    )
    expect(responses.at(-1)?.status).toBe(202)
    expect(responses.at(-1)?.headers['cache-control']).toBe('no-store')
    validate('JoinApplicationReceived', response)
  }
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_attachments'))
      .rows[0],
  ).toEqual({ n: 2 })
})

it('accepts exact GIF87a/GIF89a signatures and rejects high-bit GIF spoofing through actual multipart HTTP', async () => {
  const { f, client, responses } = await liveSetup()
  for (const signature of ['GIF87a', 'GIF89a']) {
    const response = await sendProof(
      client,
      `${signature.toLowerCase()}@example.com`,
      Buffer.from(signature),
      'image.gif',
      'image/gif',
    )
    expect(responses.at(-1)?.status).toBe(202)
    validate('JoinApplicationReceived', response)
  }
  const forged = await sendProof(
    client,
    'forged-gif@example.com',
    Uint8Array.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]),
    'filename.gif',
    'image/gif',
  ).catch((error) => error as ExAxiosError)
  expect(responses.at(-1)?.status).toBe(415)
  expect(forged).toBeInstanceOf(ExAxiosError)
  expect((forged as ExAxiosError).code).toBe('JOIN_UNSUPPORTED_MEDIA_TYPE')
  expect(responses.at(-1)?.headers['cache-control']).toBe('no-store')
  validate('ErrorEnvelope', {
    error: {
      code: (forged as ExAxiosError).code,
      message: (forged as ExAxiosError).message,
      requestId: (forged as ExAxiosError).requestId,
    },
  })
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_attachments'))
      .rows[0],
  ).toEqual({ n: 2 })
})

it('rejects large BOM/comment/XML non-SVG prefixes over real multipart HTTP within an isolated process deadline', async () => {
  const { baseUrl } = await isolatedLiveClient()
  const prefixes = [
    '\uFEFF'.repeat(50000) + '<html/>',
    '<!--前导内容-->'.repeat(50000) + '<html/>',
    '<?xml version="1.0"?>'.repeat(50000) + '<html/>',
    '<!--'.repeat(50000) + '<html/>',
  ]
  for (const [index, content] of prefixes.entries()) {
    const response = await sendProofWire(
      baseUrl,
      `svg-prefix-${index}@example.com`,
      Buffer.from(content),
      'prefix.svg',
      'image/svg+xml',
      AbortSignal.timeout(2000),
    )
    expect(response.status).toBe(415)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('JOIN_UNSUPPORTED_MEDIA_TYPE')
    expect(response.headers.get('cache-control')).toBe('no-store')
    validate('ErrorEnvelope', body)
  }
  // The child has a 30s startup deadline for its own PostgreSQL container; each
  // of the four HTTP requests independently retains its 2s abort deadline.
}, 45000)

it('validates nested normalized input without deleting unknown properties or coercing booleans', async () => {
  const { f, app } = await setup()
  const input = newJoinApplication('  Normalized@Example.COM  ', '  名字  ')
  input.form.answers.rpUnderstanding = '  角色扮演  '
  const received = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...joinMultipart(input),
  })
  expect(received.statusCode, received.body).toBe(202)
  const row = (await f.db.query('SELECT email,nickname FROM join_applications')).rows[0]
  expect(row).toEqual({
    email: expect.stringMatching(/^request-/),
    nickname: 'Applicant',
  })
  for (const value of [
    { ...newJoinApplication('bad1@example.com'), unexpected: true },
    {
      ...newJoinApplication('bad2@example.com'),
      form: { ...input.form, unexpected: true },
    },
    {
      ...newJoinApplication('bad3@example.com'),
      form: {
        ...input.form,
        commitments: { ...input.form.commitments, informationAccurate: 'true' },
      },
    },
    { ...newJoinApplication('bad4@example.com'), qq: 12345 },
  ]) {
    const response = await send(f, app, {
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...joinMultipart(value),
    })
    expect(response.statusCode, response.body).toBe(400)
    validate('ErrorEnvelope', response.json())
  }
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 1 })
})

it('rejects JSON/old shape, missing/repeated/unknown parts, invalid UTF-8, wrong MIME and new-player proofs', async () => {
  const { f, app } = await setup()
  const part = applicationPart(newJoinApplication())
  const cases = [
    [multipartBody([]), 400],
    [multipartBody([part, part]), 400],
    [multipartBody([part, { ...part, name: 'secret' }]), 400],
    [multipartBody([{ ...part, bytes: Buffer.from([0xc3, 0x28]) }]), 400],
    [multipartBody([{ ...part, bytes: Buffer.from('{broken}') }]), 400],
    [multipartBody([{ ...part, contentType: 'text/plain' }]), 415],
    [multipartBody([{ ...part, filename: undefined }]), 400],
    [joinMultipart(newJoinApplication(), [proof()]), 400],
    [joinMultipart({ email: 'old@example.com', nickname: 'Old', qq: '12345' }), 400],
    [joinMultipart(experiencedJoinApplication(), [proof(Buffer.from('not PNG'), 'fake.png')]), 415],
    [
      joinMultipart(experiencedJoinApplication(), [proof(Buffer.from('text'), '../proof.txt')]),
      400,
    ],
    [
      joinMultipart(experiencedJoinApplication(), [
        proof(Buffer.from('text'), 'folder\\proof.txt'),
      ]),
      400,
    ],
  ] as const
  for (const [request, status] of cases) {
    const response = await send(f, app, {
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...request,
    })
    expect(response.statusCode, response.body).toBe(status)
    expect(response.headers['cache-control']).toBe('no-store')
    validate('ErrorEnvelope', response.json())
  }
  expect(
    (
      await send(f, app, {
        method: 'POST',
        url: '/api/communities/rifling-911/applications',
        payload: newJoinApplication(),
      })
    ).statusCode,
  ).toBe(415)
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 0 })
})

it('enforces actual per-file, aggregate, JSON and part/header budgets and permits exact 50MiB', async () => {
  const { f, app } = await setup()
  const tenMiB = Buffer.alloc(10 * 1024 * 1024, 65)
  const accepted = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...joinMultipart(
      experiencedJoinApplication('max@example.com'),
      Array.from({ length: 5 }, (_, i) => proof(tenMiB, `${i}.txt`)),
    ),
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  expect(
    (await f.db.query<{ n: number }>('SELECT sum(byte_length) n FROM join_application_attachments'))
      .rows[0],
  ).toEqual({ n: 50 * 1024 * 1024 })
  for (const request of [
    joinMultipart(experiencedJoinApplication('over-file@example.com'), [
      proof(Buffer.alloc(tenMiB.length + 1, 65)),
    ]),
    joinMultipart(
      experiencedJoinApplication('six@example.com'),
      Array.from({ length: 6 }, () => proof()),
    ),
    multipartBody([
      {
        ...applicationPart(newJoinApplication()),
        bytes: Buffer.alloc(65537, 32),
      },
    ]),
    multipartBody([{ ...applicationPart(newJoinApplication()), name: 'x'.repeat(65) }]),
    multipartBody([
      {
        ...applicationPart(newJoinApplication()),
        extraHeaders: Array.from({ length: 31 }, (_, i) => `X-${i}: value`),
      },
    ]),
    multipartBody([
      {
        ...applicationPart(newJoinApplication()),
        extraHeaders: [`X-Large: ${'x'.repeat(16384)}`],
      },
    ]),
  ]) {
    const response = await send(f, app, {
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...request,
    })
    expect(response.statusCode, response.body).toBe(413)
    expect(response.json().error.code).toBe('JOIN_UPLOAD_TOO_LARGE')
  }
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 1 })
}, 30000)

it('permits exact JSON/header byte and header-pair budgets and rejects each next byte/pair', async () => {
  const { f, app } = await setup()
  const json = applicationPart(newJoinApplication('exact-json@example.com'))
  const exactJson = {
    ...json,
    bytes: Buffer.concat([json.bytes, Buffer.alloc(65536 - json.bytes.length, 32)]),
  }
  expect(
    (
      await send(f, app, {
        method: 'POST',
        url: '/api/communities/rifling-911/applications',
        ...multipartBody([exactJson]),
      })
    ).statusCode,
  ).toBe(202)
  const headerPart = applicationPart(newJoinApplication('exact-header@example.com'))
  const base = multipartBody([headerPart]).payload
  const start = base.indexOf('\r\n') + 2
  const headerLength = base.indexOf('\r\n\r\n') + 4 - start
  const extensionPrefix = 'X-Padding: '
  const padding = 'x'.repeat(16384 - headerLength - Buffer.byteLength(extensionPrefix + '\r\n'))
  const exactHeaders = {
    ...headerPart,
    extraHeaders: [extensionPrefix + padding],
  }
  const accepted = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...multipartBody([exactHeaders]),
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const over = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...multipartBody([{ ...exactHeaders, extraHeaders: [extensionPrefix + padding + 'x'] }]),
  })
  expect(over.statusCode).toBe(413)
  const exactPairs = {
    ...applicationPart(newJoinApplication('exact-pairs@example.com')),
    extraHeaders: Array.from({ length: 30 }, (_, i) => `X-${i}: value`),
  }
  expect(
    (
      await send(f, app, {
        method: 'POST',
        url: '/api/communities/rifling-911/applications',
        ...multipartBody([exactPairs]),
      })
    ).statusCode,
  ).toBe(202)
})

it('registers binary handlers with raw schema/Buffer checks, scoped IDs and safe download headers', async () => {
  const { f, app } = await setup()
  await f.joinServices.submit(
    reviewers.get(app)!.session,
    'rifling-911',
    experiencedJoinApplication(),
    [{ originalName: '证明.txt', bytes: Buffer.from('evidence') }],
  )
  const application = (await f.joinServices.list(reviewers.get(app)!.session, 'rifling-911', {}))
    .items[0]!
  const detail = await f.joinServices.get(
    reviewers.get(app)!.session,
    'rifling-911',
    application.id,
  )
  const attachment = detail.attachments[0]!
  const headers: Record<string, string> = {}
  const reply = {
    header(key: string, value: string) {
      headers[key.toLowerCase()] = value
      return this
    },
  } as unknown as FastifyReply
  const request = {
    server: f,
    authSession: reviewers.get(app)!.session,
    params: {
      communityId: 'rifling-911',
      applicationId: application.id,
      attachmentId: attachment.id,
    },
  } as unknown as Parameters<typeof serviceHandlers.downloadJoinApplicationAttachment>[0]
  const raw = await serviceHandlers.downloadJoinApplicationAttachment(request, reply)
  expect(Buffer.isBuffer(raw)).toBe(true)
  expect(raw.toString()).toBe('evidence')
  expect(createHash('sha256').update(raw).digest('hex')).toBe(attachment.sha256)
  expect(headers['content-type']).toBe('application/octet-stream')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['content-disposition']).toMatch(
    /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/,
  )
  const response = await send(f, app, {
    method: 'GET',
    url: `/api/admin/communities/rifling-911/applications/${application.id}/attachments/${attachment.id}`,
  })
  expect(response.statusCode).toBe(200)
  expect(response.rawPayload).toEqual(raw)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['x-request-id']).toEqual(expect.any(String))
  const notFound = await send(f, app, {
    method: 'GET',
    url: `/api/admin/communities/rifling-911/applications/20000000-0000-4000-8000-999999999999/attachments/${attachment.id}`,
  })
  expect(notFound.statusCode).toBe(404)
  expect(notFound.json().error.code).toBe('JOIN_APPLICATION_NOT_FOUND')
  expect(notFound.headers['x-request-id']).toBe(notFound.json().error.requestId)
  validate('JoinApplicationDetail', detail)
})

it('counts shared actual-IP budget once before parsing and rejects spoofed forwarded addresses', async () => {
  const { f, app } = await setup()
  const limit = vi.spyOn(f.joinServices, 'limit')
  const accepted = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...joinMultipart(newJoinApplication()),
  })
  expect(accepted.statusCode).toBe(202)
  expect(limit).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 59; i++) {
    const response = await send(f, app, {
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      payload: 'invalid multipart',
      headers: {
        'content-type': 'multipart/form-data; boundary=broken',
        'x-forwarded-for': `10.0.0.${i}`,
      },
    })
    expect(response.statusCode).toBe(400)
  }
  const rejected = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...joinMultipart(newJoinApplication()),
  })
  expect(rejected.statusCode).toBe(429)
  expect(rejected.json().error.code).toBe('JOIN_RATE_LIMITED')
  expect(limit).toHaveBeenCalledTimes(61)
  expect(new Set(limit.mock.calls.map(([ip]) => ip))).toEqual(new Set(['127.0.0.1']))
})

it('releases upload buffers and slots after storage rollback and refuses forged raw proof markers', async () => {
  const { f, app } = await setup()
  await f.db.query(`CREATE FUNCTION fail_form_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'secret form insert failure'; END $$`)
  await f.db.query(`CREATE TRIGGER fail_form_insert BEFORE INSERT ON join_application_forms
    FOR EACH ROW EXECUTE FUNCTION fail_form_insert()`)
  for (let i = 0; i < 2; i++) {
    const response = await send(f, app, {
      method: 'POST',
      url: '/api/communities/rifling-911/applications',
      ...joinMultipart(experiencedJoinApplication(`failure-${i}@example.com`), [proof()]),
    })
    expect(response.statusCode, response.body).toBe(500)
    expect(response.json().error.message).toBe('An unexpected error occurred.')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).not.toContain('join_application_forms')
  }
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_applications')).rows[0],
  ).toEqual({ n: 0 })
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_email_registry'))
      .rows[0],
  ).toEqual({ n: 0 })
  expect(
    (await f.db.query<{ n: number }>('SELECT count(*) n FROM join_application_attachments'))
      .rows[0],
  ).toEqual({ n: 0 })
  await f.db.query('DROP TRIGGER fail_form_insert ON join_application_forms')
  await f.db.query('DROP FUNCTION fail_form_insert()')
  const accepted = await send(f, app, {
    method: 'POST',
    url: '/api/communities/rifling-911/applications',
    ...joinMultipart(experiencedJoinApplication('after-storage-failure@example.com'), [proof()]),
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const reply = {
    header() {
      return this
    },
    code() {
      return this
    },
  } as unknown as FastifyReply
  await expect(
    serviceHandlers.submitJoinApplication(
      {
        server: f,
        authSession: reviewers.get(app)!.session,
        params: { communityId: 'rifling-911' },
        body: {
          application: experiencedJoinApplication('forged@example.com'),
          proofs: ['join-proof-0'],
        },
      } as unknown as Parameters<typeof serviceHandlers.submitJoinApplication>[0],
      reply,
    ),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})
