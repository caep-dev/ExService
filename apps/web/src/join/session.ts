import { useSyncExternalStore } from 'react'
import { readToken, subscribeSessionChanges } from '@web/src/auth/storage'

export function currentCommunityToken(): string | null {
  try { return readToken(window.localStorage) } catch { return null }
}
export function useCommunityToken() {
  return useSyncExternalStore(subscribeSessionChanges, currentCommunityToken, () => null)
}
