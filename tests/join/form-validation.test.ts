import { expect, it } from 'vitest'
import { newJoinApplication, experiencedJoinApplication } from '../helpers/auth'
import {
  normalizeJoinApplicationPayload,
  validateJoinApplicationPayload,
  validateStoredJoinForm,
} from '@server/src/domains/join/applications/form-validation'

const earlierTransferForm = {
  applicationType: 'experienced',
  birthDate: '2000-01-01',
  applicantCategory: '100',
  department: 'leo',
  freeTime: '周末',
  discoveryChannels: ['friends'],
  answers: {
    previousServer: '旧服务器',
    leaveReason: '迁入',
    previousDepartment: '巡逻',
    lawEnforcementExperience: '有经验',
    highestRank: '警员',
    punishmentHistory: '无',
    deescalationEssay: '字'.repeat(150),
    discretionEssay: '字'.repeat(150),
    transferReason: '继续参与',
  },
  commitments: { informationAccurate: true },
} as const

it('reads earlier transfer forms and validates the added acknowledgement when present', () => {
  const now = Date.UTC(2026, 8, 29)
  expect(validateStoredJoinForm(earlierTransferForm, now)).toEqual(earlierTransferForm)
  const currentForm = {
    ...earlierTransferForm,
    commitments: {
      ...earlierTransferForm.commitments,
      obeyCommunityRules: true,
    },
  }
  expect(validateStoredJoinForm(currentForm, now)).toEqual(currentForm)
  expect(() =>
    validateJoinApplicationPayload(
      {
        email: 'player@example.com',
        nickname: '玩家',
        qq: '0012345',
        form: {
          ...currentForm,
          commitments: {
            ...currentForm.commitments,
            obeyCommunityRules: false,
          },
        },
      },
      now,
    ),
  ).toThrow()
})

it.each([
  (v: ReturnType<typeof newJoinApplication>) => ({ ...v, unknown: true }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    email: 'forged@example.com',
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({ ...v, nickname: 'Forged' }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: { ...v.form, unknown: true },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: {
      ...v.form,
      answers: { ...v.form.answers, previousServer: 'wrong' },
    },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: {
      ...v.form,
      commitments: { ...v.form.commitments, informationAccurate: false },
    },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: { ...v.form, discoveryChannels: ['friends', 'friends'] },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: { ...v.form, freeTime: '  ' },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: { ...v.form, birthDate: '2001-02-29' },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    form: { ...v.form, birthDate: '2099-01-01' },
  }),
  (v: ReturnType<typeof newJoinApplication>) => ({ ...v, qq: '1234' }),
  (v: ReturnType<typeof newJoinApplication>) => ({
    ...v,
    qq: '12345678901234',
  }),
])('rejects invalid nested form and forged account snapshots %#', (invalid) => {
  expect(() =>
    validateJoinApplicationPayload(invalid(newJoinApplication()), Date.UTC(2026, 9, 12)),
  ).toThrow()
})
it('normalizes declared free text only, retaining unknown values and QQ for validation', () => {
  const input = {
    ...newJoinApplication(),
    form: { ...newJoinApplication().form, freeTime: '  Weekends  ' },
    extra: '  unchanged  ',
  }
  expect(normalizeJoinApplicationPayload(input)).toMatchObject({
    form: { freeTime: 'Weekends' },
    extra: '  unchanged  ',
    qq: '001234',
  })
  expect(input.form.freeTime).toBe('  Weekends  ')
})
it('counts Unicode codepoints at essay boundaries and validates today in UTC', () => {
  const input = experiencedJoinApplication(),
    now = Date.UTC(2026, 9, 12)
  input.form.answers.deescalationEssay = '😀'.repeat(149)
  expect(() => validateJoinApplicationPayload(input, now)).toThrow()
  input.form.answers.deescalationEssay = '😀'.repeat(150)
  input.form.answers.discretionEssay = '😀'.repeat(4000)
  input.form.birthDate = '2026-10-12'
  expect(validateJoinApplicationPayload(input, now)).toEqual(input)
  input.form.answers.discretionEssay = '😀'.repeat(4001)
  expect(() => validateJoinApplicationPayload(input, now)).toThrow()
})
