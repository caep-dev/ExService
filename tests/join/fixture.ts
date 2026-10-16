import { afterEach } from 'vitest'
import { createTestAuth, joinActor, newJoinApplication } from '../helpers/auth'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
export async function setup() {
  const f = await createTestAuth()
  cleanup.push(() => f.close())
  const applicant = await joinActor(f),
    reviewer = await joinActor(f, 'reviewer@example.com', true)
  const deps = {
    db: f.db,
    authServices: f.authServices,
    communityServices: f.communityServices,
    identityLinkServices: f.identityLinkServices,
    notifications: f.notifications,
    now: f.now,
  }
  return {
    ...f,
    applicant,
    reviewer,
    deps,
    input: newJoinApplication(),
    async id() {
      return (
        await f.db.query<{ id: string }>(
          'SELECT id FROM join_applications ORDER BY created_at DESC,id DESC',
        )
      ).rows[0]!.id
    },
    submit: (value: unknown, proofs: Parameters<typeof f.joinServices.submit>[3] = []) =>
      f.joinServices.submit(applicant.session, 'rifling-911', value, proofs),
    get: (id: string) => f.joinServices.get(reviewer.session, 'rifling-911', id),
    list: (query: Parameters<typeof f.joinServices.list>[2] = {}) =>
      f.joinServices.list(reviewer.session, 'rifling-911', query),
    approve: (id: string) => f.joinServices.approve(reviewer.session, 'rifling-911', id),
    reject: (id: string) => f.joinServices.reject(reviewer.session, 'rifling-911', id),
    download: (id: string, attachmentId: string) =>
      f.joinServices.download(reviewer.session, 'rifling-911', id, attachmentId),
  }
}
