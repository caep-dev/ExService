import { afterEach, expect, it, vi } from 'vitest'
import { experiencedJoinApplicationSchema, type ExperiencedJoinApplicationDraft } from '@workspace/components'
import { submitApplication } from '@web/src/join/client'

const post = vi.hoisted(() => vi.fn())
vi.mock('@web/src/api/client', () => ({ api: { POST: post } }))
afterEach(() => { post.mockReset() })

const longFields = ['leaveReason', 'lawEnforcementExperience', 'punishmentHistory', 'deescalationEssay', 'discretionEssay', 'transferReason'] as const
function draft(length = 150): ExperiencedJoinApplicationDraft {
  return {
    qq: '001234', proofs: [],
    form: {
      applicationType: 'experienced', birthDate: '2000-01-01', applicantCategory: '100', department: 'leo', freeTime: '周末', discoveryChannels: ['friends'],
      answers: { previousServer: '旧服', leaveReason: '中'.repeat(length), previousDepartment: '巡逻', lawEnforcementExperience: '中'.repeat(length), highestRank: '警员', punishmentHistory: '中'.repeat(length), deescalationEssay: '中'.repeat(length), discretionEssay: '中'.repeat(length), transferReason: '中'.repeat(length) },
      commitments: { informationAccurate: true, obeyCommunityRules: true },
    },
  }
}
function payloadSize(value: ExperiencedJoinApplicationDraft) {
  const { proofs: _proofs, ...application } = value
  return new Blob([JSON.stringify(application)]).size
}
function draftAtBytes(bytes: number) {
  const value = draft(3500)
  let additional = bytes - payloadSize(value)
  for (const field of longFields) {
    const count = Math.min(500, additional)
    value.form.answers[field] += 'a'.repeat(count)
    additional -= count
  }
  expect(additional).toBe(0)
  expect(payloadSize(value)).toBe(bytes)
  expect(experiencedJoinApplicationSchema.safeParse(value).success).toBe(true)
  return value
}
it('rejects individually valid multibyte answers whose combined JSON exceeds 64 KiB without posting or attachments', async () => {
  const value = draft(4000)
  expect(experiencedJoinApplicationSchema.safeParse(value).success).toBe(true)
  expect(value.proofs).toHaveLength(0)
  expect(payloadSize(value)).toBeGreaterThan(65536)
  post.mockResolvedValue({ status: 'received' })
  await expect(Promise.resolve().then(() => submitApplication(value, 'rifling-911', 'owner'))).rejects.toThrow('申请文字资料总量超出限制，请缩短较长的回答后重试')
  expect(post).not.toHaveBeenCalled()
})
it.each([65535, 65536])('sends a valid JSON Blob with %i UTF-8 bytes', async bytes => {
  const value = draftAtBytes(bytes)
  post.mockResolvedValue({ status: 'received' })
  await submitApplication(value, 'rifling-911', 'owner')
  const options = post.mock.calls[0]![1]
  const parts = options.body
  expect(parts.get('application').size).toBe(bytes)
  expect(parts.get('application').type).toBe('application/json')
  expect(parts.get('application').name).toBe('application.json')
  expect(Array.from(parts.keys())).toEqual(['application'])
  expect(options.headers).toEqual({ Authorization: 'Bearer owner' })
})
it('rejects one UTF-8 byte over the budget even though every answer remains valid', async () => {
  const value = draftAtBytes(65537)
  post.mockResolvedValue({ status: 'received' })
  await expect(Promise.resolve().then(() => submitApplication(value, 'rifling-911', 'owner'))).rejects.toThrow('申请文字资料总量超出限制，请缩短较长的回答后重试')
  expect(post).not.toHaveBeenCalled()
})
it('keeps normal submissions and repeated proof files in one multipart operation', async () => {
  const value = draft()
  const file = new File(['proof'], 'proof.txt', { type: 'text/plain' })
  value.proofs = [file]
  post.mockResolvedValue({ status: 'received' })
  const response = await submitApplication(value, 'rifling-911', 'owner')
  expect(response.status).toBe('received')
  expect(post).toHaveBeenCalledTimes(1)
  const [path, options] = post.mock.calls[0]!
  expect(path).toBe('/communities/{communityId}/applications')
  const parts = options.body
  const application = JSON.parse(await parts.get('application').text())
  expect(application.form.answers.deescalationEssay).toBe('中'.repeat(150))
  expect(application).not.toHaveProperty('proofs')
  expect(parts.getAll('proofs')).toHaveLength(1)
  expect(await parts.get('proofs').text()).toBe('proof')
})
