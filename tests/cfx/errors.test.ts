import { expect, it } from 'vitest'
import { CfxError } from '@server/src/modules/cfx/errors'

it.each(['CFX_DISABLED', 'CFX_CAPACITY_EXCEEDED', 'CFX_SERVICE_CLOSED'] as const)(
  'supplies a conservative retry interval for %s while preserving explicit overrides',
  (code) => {
    expect(new CfxError(code)).toMatchObject({ statusCode: 503, retryAfterSeconds: 60 })
    expect(new CfxError(code, 7)).toMatchObject({ statusCode: 503, retryAfterSeconds: 7 })
  },
)

it('preserves existing non-503 retry semantics', () => {
  expect(new CfxError('CFX_REQUEST_LIMITED', 12).retryAfterSeconds).toBe(12)
  expect(new CfxError('CFX_ATTEMPT_NOT_FOUND').retryAfterSeconds).toBeUndefined()
})
