import { expect, it } from 'vitest'
import { compileComponentSchema, readContract } from '@tests/helpers/contract'

it('registration completion only accepts a grant, name and mandatory password', () => {
  expect(readContract().schemas).toHaveProperty('CompletePublicRegistrationRequest')
  const validate = compileComponentSchema('CompletePublicRegistrationRequest')
  const input = { registrationToken: 'A'.repeat(43), nickname: 'Member', password: 'valid password' }
  expect(validate(input)).toBe(true)
  expect(validate({ ...input, email: 'other@example.com' })).toBe(false)
  expect(validate({ ...input, externalUserId: '123' })).toBe(false)
  expect(validate({ registrationToken: input.registrationToken, nickname: input.nickname })).toBe(false)
})

it('Cfx sign-in results distinguish a session from registration and existing-account guidance', () => {
  expect(readContract().schemas).toHaveProperty('CfxSignInResult')
  const validate = compileComponentSchema('CfxSignInResult')
  expect(validate({ kind: 'signed-in', token: 'A'.repeat(43), expiresAt: 100 })).toBe(true)
  expect(validate({ kind: 'registration-required', registrationToken: 'A'.repeat(43), email: 'm@example.com', suggestedNickname: null, expiresAt: 100 })).toBe(true)
  expect(validate({ kind: 'account-exists', email: 'm@example.com', nextAction: 'login_then_link' })).toBe(true)
  expect(validate({ kind: 'account-exists', email: 'm@example.com', nextAction: 'login_then_link', token: 'A'.repeat(43) })).toBe(false)
})

it('new community applications reject client-supplied ownership and retain the form validation', () => {
  const validate = compileComponentSchema('JoinApplicationPayload')
  const form = { applicationType: 'new', birthDate: '2000-02-29', applicantCategory: '100', department: 'leo', freeTime: 'evenings', discoveryChannels: ['friends'],
    answers: { fiveMExperience: 'none', emergencyRoleplayKnowledge: 'learning', emergencyProceduresKnowledge: 'learning', rpUnderstanding: 'roleplay', frpUnderstanding: 'rules' },
    commitments: { informationAccurate: true, obeyCommunityRules: true, acceptAcademyAttendanceConsequences: true } }
  const input = { qq: '001234', form }
  expect(validate(input)).toBe(true)
  for (const key of ['email', 'nickname', 'userId', 'externalUserId']) expect(validate({ ...input, [key]: 'injected' })).toBe(false)
  expect(validate({ ...input, form: { ...form, commitments: { ...form.commitments, obeyCommunityRules: false } } })).toBe(false)
})

it('identity provider slots cannot enable reserved providers or contain another provider identity', () => {
  const validate = compileComponentSchema('IdentityLinksResponse')
  const cfx = { provider: 'cfx', available: true, link: null }
  const google = { provider: 'google', available: false, link: null }
  const qq = { provider: 'qq', available: false, link: null }
  expect(validate({ providers: [cfx, google, qq] })).toBe(true)
  expect(validate({ providers: [cfx, cfx, cfx] })).toBe(false)
  expect(validate({ providers: [cfx, { ...google, available: true }, qq] })).toBe(false)
  expect(validate({ providers: [cfx, { ...google, link: { id: '10000000-0000-4000-8000-000000000001', provider: 'cfx', externalUserId: '1', externalUsername: 'CfxUser', providerEmail: 'm@example.com', linkedAt: 1 } }, qq] })).toBe(false)
})
