import type { components } from '@workspace/api-client'
import type { JoinApplicationDraft } from '@workspace/components'
import { api } from '@web/src/api/client'

export class JoinApplicationTextLimitError extends Error {
  constructor() {
    super('申请文字资料总量超出限制，请缩短较长的回答后重试')
    this.name = 'JoinApplicationTextLimitError'
  }
}

export function submitApplication(draft: JoinApplicationDraft, communityId: string, token: string) {
  const contact = { qq: draft.qq }
  const body: components['schemas']['JoinApplicationRequest'] = draft.form.applicationType === 'new'
    ? { application: { ...contact, form: draft.form }, proofs: [] }
    : { application: { ...contact, form: draft.form }, proofs: draft.proofs.map(() => 'binary') }
  const application = new Blob([JSON.stringify(body.application)], { type: 'application/json' })
  // Match the upload operation's jsonBytes budget in api/openapi.yaml, using actual UTF-8 bytes.
  if (application.size > 64 * 1024) throw new JoinApplicationTextLimitError()
  const parts = new FormData()
  parts.append('application', application, 'application.json')
  for (const file of draft.proofs) parts.append('proofs', file, file.name)
  return api.POST('/communities/{communityId}/applications', {
    params: { path: { communityId } },
    headers: { Authorization: `Bearer ${token}` },
    body: parts,
    timeout: 120_000,
    alert: false,
  })
}
