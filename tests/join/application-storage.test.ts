import { createHash } from 'node:crypto'
import { expect, it, vi, afterEach } from 'vitest'
import {
  experiencedJoinApplication,
  newJoinApplication,
  joinSnapshot,
  joinActor,
} from '../helpers/auth'
import { setup } from './fixture'
import {
  MAX_PROOF_BYTES,
  validateJoinProofs,
} from '@server/src/domains/join/applications/attachment-validation'
import { normalizeJoinApplicationPayload } from '@server/src/domains/join/applications/form-validation'
const proof = (originalName = 'proof.txt', bytes = Buffer.from('证明材料')) => ({
  originalName,
  bytes,
})
const code = (value: string) => expect.objectContaining({ code: value })
afterEach(() => vi.restoreAllMocks())
it('stores normalized forms and exact attachments while account snapshots come from the session', async () => {
  const f = await setup(),
    input = experiencedJoinApplication()
  input.form.freeTime = '  周末  '
  input.form.answers.leaveReason = '  自由填写\n第二行  '
  const files = [proof('证明.PDF', Buffer.from('%PDF-1.7\ncontent')), proof()]
  await f.submit(input, files)
  const id = await f.id(),
    result = await f.get(id)
  expect(result).toMatchObject({
    formVersion: 1,
    application: {
      applicationType: 'experienced',
      email: 'applicant@example.com',
      nickname: 'Applicant',
    },
    form: { freeTime: '周末', answers: { leaveReason: '自由填写\n第二行' } },
  })
  for (const [ordinal, metadata] of result.attachments.entries()) {
    const file = files[ordinal]!
    expect(metadata).toMatchObject({
      originalName: file.originalName,
      ordinal,
      byteLength: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })
    expect(Object.keys(metadata).sort()).toEqual([
      'byteLength',
      'extension',
      'id',
      'ordinal',
      'originalName',
      'sha256',
    ])
    expect((await f.download(id, metadata.id)).bytes).toEqual(file.bytes)
  }
  const other = await joinActor(f, 'new@example.com')
  await f.joinServices.submit(other.session, 'rifling-911', newJoinApplication())
  expect(await f.get(await f.id())).toMatchObject({
    application: { applicationType: 'new' },
    attachments: [],
  })
})
it.each(['join_applications', 'join_application_forms', 'join_application_attachments'])(
  'rolls back when %s persistence fails',
  async (table) => {
    const f = await setup(),
      before = await joinSnapshot(f)
    await f.db.query(
      `CREATE FUNCTION deny_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$`,
    )
    await f.db.query(
      `CREATE TRIGGER deny_storage BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION deny_storage()`,
    )
    await expect(f.submit(experiencedJoinApplication(), [proof()])).rejects.toThrow(
      'injected storage failure',
    )
    expect(await joinSnapshot(f)).toEqual(before)
    await f.db.query(`DROP TRIGGER deny_storage ON ${table}`)
    await expect(f.submit(experiencedJoinApplication(), [proof()])).resolves.toEqual({
      status: 'received',
    })
  },
)
it('rolls back after the first attachment is stored and preserves unexpected unique failures', async () => {
  const f = await setup(),
    before = await joinSnapshot(f)
  await f.db.query(
    `CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ordinal=1 THEN RAISE EXCEPTION 'second failed'; END IF; RETURN NEW; END $$`,
  )
  await f.db.query(
    'CREATE TRIGGER fail_second BEFORE INSERT ON join_application_attachments FOR EACH ROW EXECUTE FUNCTION fail_second()',
  )
  await expect(
    f.submit(experiencedJoinApplication(), [proof(), proof('second.txt')]),
  ).rejects.toThrow('second failed')
  expect(await joinSnapshot(f)).toEqual(before)
  await f.db.query('DROP TRIGGER fail_second ON join_application_attachments')
  const transaction = f.db.transaction.bind(f.db)
  vi.spyOn(f.db, 'transaction').mockImplementation((run, mode) =>
    transaction(
      async (tx) =>
        run({
          query: async (sql, values) => {
            if (sql.startsWith('INSERT INTO join_application_forms')) await tx.query(sql, values)
            return tx.query(sql, values)
          },
        }),
      mode,
    ),
  )
  await expect(f.submit(newJoinApplication())).rejects.toMatchObject({
    code: '23505',
  })
  expect(await joinSnapshot(f)).toEqual(before)
})
it.each(['missing', 'invalid-json', 'wrong-type', 'extra-field', 'bad-snapshot'])(
  'fails closed on corrupt version 1 data: %s',
  async (variant) => {
    const f = await setup()
    await f.submit(newJoinApplication())
    const id = await f.id()
    if (variant === 'missing')
      await f.db.query('DELETE FROM join_application_forms WHERE application_id=$1', [id])
    else if (variant === 'invalid-json')
      await f.db.query('UPDATE join_application_forms SET form_json=$1 WHERE application_id=$2', [
        '{',
        id,
      ])
    else if (variant === 'wrong-type')
      await f.db.query(
        "UPDATE join_application_forms SET application_type='experienced' WHERE application_id=$1",
        [id],
      )
    else if (variant === 'bad-snapshot')
      await f.db.query('UPDATE join_applications SET identity_snapshot_json=$1 WHERE id=$2', [
        JSON.stringify({ provider: 'cfx', externalUserId: 'invalid' }),
        id,
      ])
    else
      await f.db.query('UPDATE join_application_forms SET form_json=$1 WHERE application_id=$2', [
        JSON.stringify({ ...newJoinApplication().form, extra: true }),
        id,
      ])
    const before = await joinSnapshot(f)
    await expect(f.get(id)).rejects.toThrow()
    await expect(f.list()).rejects.toThrow()
    await expect(f.approve(id)).rejects.toThrow()
    expect(await joinSnapshot(f)).toEqual(before)
  },
)
it('does not read attachment bytes for list/detail and scopes download to application IDs', async () => {
  const f = await setup()
  await f.submit(experiencedJoinApplication(), [proof()])
  const id = await f.id(),
    statements: string[] = [],
    transaction = f.db.transaction.bind(f.db)
  vi.spyOn(f.db, 'transaction').mockImplementation((run, mode) =>
    transaction(
      (tx) =>
        run({
          query: (sql, values) => {
            statements.push(sql)
            return tx.query(sql, values)
          },
        }),
      mode,
    ),
  )
  await f.list()
  const result = await f.get(id),
    queries = statements.filter((sql) => sql.includes('join_application_attachments'))
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.every((sql) => !sql.includes('bytes') && !sql.includes('*'))).toBe(true)
  await expect(f.download('other', result.attachments[0]!.id)).rejects.toMatchObject({
    code: 'JOIN_APPLICATION_NOT_FOUND',
  })
  await expect(f.download(id, 'missing')).rejects.toMatchObject({
    code: 'JOIN_ATTACHMENT_NOT_FOUND',
  })
})
it('preserves ordered metadata and detects corrupted attachment digests', async () => {
  const f = await setup()
  await f.submit(
    experiencedJoinApplication(),
    Array.from({ length: 5 }, (_, i) => proof(`${i}.txt`, Buffer.from(`proof ${i}`))),
  )
  const id = await f.id(),
    detail = await f.get(id)
  expect(detail.attachments.map((file) => file.ordinal)).toEqual([0, 1, 2, 3, 4])
  await f.db.query('UPDATE join_application_attachments SET sha256=$1 WHERE id=$2', [
    '0'.repeat(64),
    detail.attachments[0]!.id,
  ])
  await expect(f.download(id, detail.attachments[0]!.id)).rejects.toThrow('inconsistent')
})
it.each([
  ['png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ['jpg', Buffer.from([255, 216, 255])],
  ['jpeg', Buffer.from([255, 216, 255])],
  ['gif', Buffer.from('GIF89a')],
  ['bmp', Buffer.from('BM')],
  ['pdf', Buffer.from('%PDF-')],
  ['doc', Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])],
  ['xls', Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])],
  ['ppt', Buffer.from([208, 207, 17, 224, 161, 177, 26, 225])],
  ['docx', Buffer.from([80, 75, 3, 4])],
  ['xlsx', Buffer.from([80, 75, 5, 6])],
  ['pptx', Buffer.from([80, 75, 7, 8])],
  ['zip', Buffer.from([80, 75, 3, 4])],
  ['rar', Buffer.from([82, 97, 114, 33, 26, 7, 0])],
  ['7z', Buffer.from([55, 122, 188, 175, 39, 28])],
  ['txt', Buffer.from('合法UTF-8')],
  [
    'svg',
    Buffer.from(
      '\uFEFF <?xml version="1.0"?><!--root--><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ),
  ],
])('accepts declared %s file family signatures without relying on MIME', (extension, bytes) => {
  expect(
    validateJoinProofs([proof(`proof.${extension}`, bytes)], 'experienced')[0]!.extension,
  ).toBe(extension)
})
it.each([
  ['proof.png', Buffer.from('%PDF-')],
  ['proof.exe', Buffer.from('MZ')],
  ['proof.txt', Buffer.from([0xc3, 0x28])],
  ['proof.txt', Buffer.from('nul\0')],
  ['proof.svg', Buffer.from('<!DOCTYPE svg><svg></svg>')],
  ['proof.svg', Buffer.from('<!ENTITY bad "x"><svg></svg>')],
  ['proof.svg', Buffer.from('<html></html>')],
])('rejects unsupported signature/text %s', (name, bytes) => {
  expect(() => validateJoinProofs([proof(name, bytes)], 'experienced')).toThrow(
    code('JOIN_UNSUPPORTED_MEDIA_TYPE'),
  )
})
it.each([
  '../proof.txt',
  'a\\proof.txt',
  'bad\r\n.txt',
  'bad".txt',
  '.',
  '..',
  '😀'.repeat(256) + '.txt',
])('rejects unsafe filename %s', (name) => {
  expect(() => validateJoinProofs([proof(name)], 'experienced')).toThrow(code('BAD_REQUEST'))
})
it('enforces zero/five/six attachments, actual byte lengths and 10MiB boundary', () => {
  const bytes = Buffer.alloc(MAX_PROOF_BYTES, 65)
  expect(validateJoinProofs([], 'new')).toEqual([])
  expect(
    validateJoinProofs(
      Array.from({ length: 5 }, () => proof('proof.txt', bytes)),
      'experienced',
    ),
  ).toHaveLength(5)
  expect(() =>
    validateJoinProofs(
      Array.from({ length: 6 }, () => proof()),
      'experienced',
    ),
  ).toThrow(code('JOIN_UPLOAD_TOO_LARGE'))
  expect(() =>
    validateJoinProofs([proof('proof.txt', Buffer.alloc(MAX_PROOF_BYTES + 1, 65))], 'experienced'),
  ).toThrow(code('JOIN_UPLOAD_TOO_LARGE'))
  expect(() => validateJoinProofs([proof('empty.txt', Buffer.alloc(0))], 'experienced')).toThrow(
    code('BAD_REQUEST'),
  )
  expect(() => validateJoinProofs([proof()], 'new')).toThrow(code('BAD_REQUEST'))
})

it.each([
  '<svg/>',
  '<?xml version="1.0"?><svg/>',
  '\uFEFF\n<!-- root -->\n<svg/>',
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
])('accepts a self-closing SVG root with ordinary XML prolog: %s', (content) => {
  expect(
    validateJoinProofs([proof('root.svg', Buffer.from(content))], 'experienced')[0]!.extension,
  ).toBe('svg')
})
it.each(['GIF87a', 'GIF89a'])('recognizes exact GIF signature %s', (signature) => {
  expect(
    validateJoinProofs([proof('image.gif', Buffer.from(signature))], 'experienced')[0]!.extension,
  ).toBe('gif')
})
it('rejects high-bit GIF bytes that lossy ASCII decoding disguises as GIF89a', () => {
  expect(() =>
    validateJoinProofs(
      [proof('image.gif', Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]))],
      'experienced',
    ),
  ).toThrow(code('JOIN_UNSUPPORTED_MEDIA_TYPE'))
})
it.each([
  Buffer.from('<!DOCTYPE svg><svg/>'),
  Buffer.from('<?xml version="1.0"?><!ENTITY name "value"><svg/>'),
  Buffer.from('<svg>\0</svg>'),
  Buffer.from([0xc3, 0x28]),
  Buffer.from('<?xml version="1.0"?><svg-like/>'),
])('retains SVG declaration, NUL, UTF-8 and non-root rejections %#', (bytes) => {
  expect(() => validateJoinProofs([proof('root.svg', bytes)], 'experienced')).toThrow(
    code('JOIN_UNSUPPORTED_MEDIA_TYPE'),
  )
})
