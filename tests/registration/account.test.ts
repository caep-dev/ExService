import { expect, it } from 'vitest'
import { isolatedPostgres } from '../helpers/postgres'
import { AuthService } from '@server/src/modules/auth/service'

it('creates an ordinary account and session in the caller transaction and rolls both back', async () => {
  expect(AuthService.prototype.createAccountInside).toBeTypeOf('function')
  const f = await isolatedPostgres()
  try {
    const auth = new AuthService({ db: f.db })
    await expect(
      f.db.transaction(async (tx) => {
        const user = await auth.createAccountInside(
          tx,
          { email: ' USER@example.com ', nickname: 'User' },
          'hash',
        )
        const session = await auth.createSessionInside(tx, user.id)
        expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect((await tx.query('SELECT email FROM auth_users')).rows).toEqual([{ email: 'user@example.com' }])
        expect((await tx.query('SELECT * FROM community_group_memberships')).rows).toHaveLength(0)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect((await f.db.query('SELECT * FROM auth_users')).rows).toHaveLength(0)
    expect((await f.db.query('SELECT * FROM auth_sessions')).rows).toHaveLength(0)
  } finally {
    await f.close()
  }
})
