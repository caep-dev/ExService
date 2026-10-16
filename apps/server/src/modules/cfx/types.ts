import type { components } from '@workspace/api-client/types'
import type { CfxConfig } from './config.js'

export type CfxIdentity = components['schemas']['CfxIdentity']
export type CfxAttemptCreated = components['schemas']['CfxAttemptCreated']
export type CfxAttemptStatus = components['schemas']['CfxAttemptStatus']
export type CfxCompletion = components['schemas']['CfxCompletion']
export type CfxCancellation = components['schemas']['CfxCancellation']
export type CfxFailureCode = components['schemas']['CfxFailureCode']
export interface CfxBrowserContext { readonly bindingDigest: string; readonly clientIp: string }
export interface CfxServices {
  readonly config: CfxConfig
  start(): void
  close(): Promise<void>
  begin(input: { bindingToken?: string; clientIp: string; signal?: AbortSignal }): Promise<{ response: CfxAttemptCreated; cookieValue: string }>
  resolveBrowserContext(input: { bindingToken: string; clientIp: string }): CfxBrowserContext
  complete(input: { context: CfxBrowserContext; attemptId: string; payload: string; source: 'manual' | 'redirect'; signal?: AbortSignal }): Promise<CfxCompletion>
  inspect(context: CfxBrowserContext, attemptId: string): CfxAttemptStatus
  cancel(context: CfxBrowserContext, attemptId: string): CfxCancellation
  consumeIdentity(input: { context: CfxBrowserContext; identityTicket: string; expectedAttemptId?: string }): CfxIdentity
}
