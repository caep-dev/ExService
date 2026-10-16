import { createApiClient } from '../../packages/api-client/src/client.js'
import { createExAxios } from '../../packages/sdk/src/http/node.js'
import type { components } from '../../packages/api-client/src/generated/schema.js'

const client = createApiClient({ baseUrl: 'http://127.0.0.1/api', transport: async () => ({}) })
const http = createExAxios({ baseUrl: 'http://127.0.0.1/api' })
const known: Promise<{ status: 'ok' }> = client.GET('/health')
const explicit: Promise<{ ok: boolean }> = http<{ ok: boolean }>({ url: '/health' })
const unknownResult: Promise<unknown> = http({ url: '/health' })
// @ts-expect-error An untyped ExAxios result is unknown.
const invented: Promise<{ ok: boolean }> = http({ url: '/health' })
// @ts-expect-error GET cannot call a POST operation.
client.GET('/auth/login')
// @ts-expect-error The path is absent from the generated contract.
client.GET('/missing')
// @ts-expect-error The login operation requires a request body.
client.POST('/auth/login')
// @ts-expect-error The operation requires both path parameters.
client.GET('/admin/communities/{communityId}/applications/{applicationId}/attachments/{attachmentId}')
// @ts-expect-error The storage file operation requires its query parameter.
client.GET('/storage/files')
// @ts-expect-error A params wrapper without its required query is invalid.
client.GET('/storage/files', { params: {} })
client.GET('/storage/files', { params: { query: { key: 'demo/file.bin' } }, responseType: 'arraybuffer' })
// @ts-expect-error Query fields come from the generated operation.
client.GET('/admin/communities/{communityId}/applications', { params: { path: { communityId: 'rifling-911' }, query: { invented: 'x' } } })
// @ts-expect-error JSON operations do not accept FormData.
client.POST('/auth/login', { body: new FormData() })
client.POST('/communities/{communityId}/applications', { params: { path: { communityId: 'rifling-911' } }, body: new FormData() })
// @ts-expect-error Multipart operations require FormData.
client.POST('/communities/{communityId}/applications', { params: { path: { communityId: 'rifling-911' } }, body: { application: {} } })
const downloaded: Promise<Blob> = client.GET('/admin/communities/{communityId}/applications/{applicationId}/attachments/{attachmentId}', {
  params: { path: { communityId: 'rifling-911', applicationId: 'a', attachmentId: 'b' } }, responseType: 'blob',
})
// @ts-expect-error Explicit blob response is not a JSON DTO.
const wrongDownload: Promise<{ status: string }> = client.GET('/admin/communities/{communityId}/applications/{applicationId}/attachments/{attachmentId}', {
  params: { path: { communityId: 'rifling-911', applicationId: 'a', attachmentId: 'b' } }, responseType: 'blob',
})
type BugIntake = Extract<components['schemas']['FeedbackPrepare']['form'], { kind: 'bug' }>
const selectedBugCategory: BugIntake['typeOptionId'] = '00000000-0000-4000-8000-000000000001'
// @ts-expect-error New Bug submissions require a classification.
const missingBugCategory: BugIntake['typeOptionId'] = null
const previousBugCategory: components['schemas']['FeedbackBugForm']['typeOptionId'] = null
// @ts-expect-error Retired invitation endpoints are absent.
client.POST('/auth/invitations/complete', { body: { completionToken: 'a', nickname: 'x', password: 'password' } })
// @ts-expect-error A registration grant determines the email.
client.POST('/auth/registrations', { body: { registrationToken: 'a', nickname: 'x', password: 'password', email: 'm@example.com' } })
void [known, explicit, unknownResult, invented, downloaded, wrongDownload, selectedBugCategory, missingBugCategory, previousBugCategory]
