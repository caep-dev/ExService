// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { newJoinApplicationSchema, experiencedJoinApplicationSchema, proofFilesSchema } from '@components/src/join/applicationSchemas'

export const validNewDraft = {
  qq: '0012345', proofs: [],
  form: { applicationType: 'new', birthDate: '2000-02-29', applicantCategory: '100', department: 'leo',
    freeTime: '每晚都有空', discoveryChannels: ['friends'],
    answers: { fiveMExperience: '没有接触过', emergencyRoleplayKnowledge: '不了解', emergencyProceduresKnowledge: '愿意学习', rpUnderstanding: '扮演角色', frpUnderstanding: '不符合角色扮演的行为' },
    commitments: { informationAccurate: true, obeyCommunityRules: true, acceptAcademyAttendanceConsequences: true } },
}
export const validExperiencedDraft = {
  ...validNewDraft, form: { ...validNewDraft.form, applicationType: 'experienced',
    answers: { previousServer: '原服务器', leaveReason: '想学习', previousDepartment: '巡逻', lawEnforcementExperience: '有执法经验', highestRank: '警员', punishmentHistory: '无', deescalationEssay: '😀'.repeat(150), discretionEssay: '学'.repeat(150), transferReason: '愿意认真扮演' },
    commitments: { informationAccurate: true, obeyCommunityRules: true } },
}

describe('完整申请规则', () => {
  it('normalizes contact fields while preserving leading QQ zeros', () => {
    const result = newJoinApplicationSchema.parse(validNewDraft)
    expect(result).not.toHaveProperty('email')
    expect(result.qq).toBe('0012345')
  })
  it('counts Unicode codepoints after trim for written answers', () => {
    expect(experiencedJoinApplicationSchema.safeParse(validExperiencedDraft).success).toBe(true)
    expect(experiencedJoinApplicationSchema.safeParse({ ...validExperiencedDraft, form: { ...validExperiencedDraft.form, answers: { ...validExperiencedDraft.form.answers, deescalationEssay: ' 😀'.trim().repeat(149) } } }).success).toBe(false)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, nickname: 'injected' }).success).toBe(false)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, email: 'injected@example.com' }).success).toBe(false)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, form: { ...validNewDraft.form, answers: { ...validNewDraft.form.answers, rpUnderstanding: `  ${'😀'.repeat(4000)}  ` } } }).success).toBe(true)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, form: { ...validNewDraft.form, answers: { ...validNewDraft.form.answers, rpUnderstanding: '😀'.repeat(4001) } } }).success).toBe(false)
  })
  it('reports the breached minimum or maximum text length', () => {
    const parseAnswer = (value: string) => experiencedJoinApplicationSchema.safeParse({
      ...validExperiencedDraft,
      form: { ...validExperiencedDraft.form, answers: { ...validExperiencedDraft.form.answers, deescalationEssay: value } },
    })
    const tooShort = parseAnswer('😀'.repeat(149))
    const tooLong = parseAnswer('字'.repeat(4001))
    for (const value of ['', '  \n  ']) {
      const empty = parseAnswer(value)
      expect(empty.success).toBe(false)
      if (!empty.success) expect(empty.error.issues.map(issue => issue.message)).toEqual(['必须填写'])
    }
    expect(tooShort.success).toBe(false)
    expect(tooLong.success).toBe(false)
    if (!tooShort.success) expect(tooShort.error.issues.map(issue => issue.message)).toContain('至少150个文字')
    if (!tooLong.success) expect(tooLong.error.issues.map(issue => issue.message)).toContain('至多4000个文字')
  })
  it('rejects invalid/future UTC calendar dates, duplicate channels and false commitments', () => {
    for (const birthDate of ['2001-02-29', '2026-02-30', '2999-01-01']) {
      expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, form: { ...validNewDraft.form, birthDate } }).success).toBe(false)
    }
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, form: { ...validNewDraft.form, discoveryChannels: ['friends', 'friends'] } }).success).toBe(false)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, form: { ...validNewDraft.form, commitments: { ...validNewDraft.form.commitments, informationAccurate: false } } }).success).toBe(false)
    expect(experiencedJoinApplicationSchema.safeParse({ ...validExperiencedDraft, form: { ...validExperiencedDraft.form, commitments: { ...validExperiencedDraft.form.commitments, obeyCommunityRules: false } } }).success).toBe(false)
  })
  it('rejects category pollution and new applicant proofs', () => {
    expect(newJoinApplicationSchema.safeParse(validExperiencedDraft).success).toBe(false)
    expect(experiencedJoinApplicationSchema.safeParse(validNewDraft).success).toBe(false)
    expect(newJoinApplicationSchema.safeParse({ ...validNewDraft, proofs: [new File(['x'], 'x.txt')] }).success).toBe(false)
  })
  it('accepts zero/five allowed files and the 10 MiB boundary, rejects count/type/size/empty boundaries', () => {
    expect(proofFilesSchema.safeParse([]).success).toBe(true)
    expect(proofFilesSchema.safeParse(Array.from({ length: 5 }, () => new File(['x'], 'proof.TXT'))).success).toBe(true)
    expect(proofFilesSchema.safeParse(Array.from({ length: 6 }, () => new File(['x'], 'proof.txt'))).success).toBe(false)
    expect(proofFilesSchema.safeParse([new File([new Uint8Array(10 * 1024 * 1024)], 'proof.zip')]).success).toBe(true)
    expect(proofFilesSchema.safeParse([new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'proof.zip')]).success).toBe(false)
    expect(proofFilesSchema.safeParse([new File(['x'], 'proof.exe')]).success).toBe(false)
    expect(proofFilesSchema.safeParse([new File(['x'], 'proof?.txt')]).success).toBe(false)
    expect(proofFilesSchema.safeParse([new File([], 'proof.txt')]).success).toBe(false)
    expect(proofFilesSchema.safeParse([{}]).success).toBe(false)
  })
})
