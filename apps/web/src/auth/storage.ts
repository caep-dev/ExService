export const AUTH_TOKEN_KEY = 'exwebsite.auth.token'
export const SSO_SUCCESS_KEY = 'exwebsite.auth.sso-success'
let updateHttpToken: ((token: string | null) => void) | undefined
export type SessionChangeSource = 'storage' | 'http' | 'write' | 'remove' | 'logout'
const subscribers = new Set<(token: string | null, source: SessionChangeSource) => void>()

export function bindSessionHttp(setToken: (token: string | null) => void): void {
  updateHttpToken = setToken
  try { setToken(readToken(window.localStorage)) } catch { setToken(null) }
}

export function subscribeSessionChanges(listener: (token: string | null, source: SessionChangeSource) => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

function changed(token: string | null, source: SessionChangeSource): void {
  updateHttpToken?.(token)
  for (const listener of subscribers) listener(token, source)
}

export function startSessionSync(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_TOKEN_KEY) return
    syncSessionToken('storage')
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

export function syncSessionToken(source: 'storage' | 'http' = 'http'): string | null | undefined {
  try {
    const token = readToken(window.localStorage)
    changed(token, source)
    return token
  } catch { changed(null, source); return undefined }
}

export function readToken(storage: Pick<Storage, 'getItem'>): string | null {
  return storage.getItem(AUTH_TOKEN_KEY)
}

export function writeToken(storage: Pick<Storage, 'setItem'>, token: string): void {
  storage.setItem(AUTH_TOKEN_KEY, token)
  changed(token, 'write')
}

export function removeMatchingToken(storage: Pick<Storage, 'getItem' | 'removeItem'>, token: string): void {
  if (storage.getItem(AUTH_TOKEN_KEY) === token) {
    storage.removeItem(AUTH_TOKEN_KEY)
    changed(null, 'remove')
  }
}

/** Explicit logout clears browser state before any remote revocation can finish. */
export function clearBrowserSession(): void {
  try { window.localStorage.removeItem(AUTH_TOKEN_KEY) } catch { /* still clear in-memory authentication */ }
  try { window.sessionStorage.removeItem(SSO_SUCCESS_KEY) } catch { /* independent of token cleanup */ }
  changed(null, 'logout')
}

export function writeSsoSuccess(
  storage: Pick<Storage, 'setItem'>,
  record: { ssoRequestId: string; confirmedAt: number },
): void {
  storage.setItem(SSO_SUCCESS_KEY, JSON.stringify(record))
}

export function readRecentSsoSuccess(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  now: number,
): { ssoRequestId: string; confirmedAt: number } | null {
  const raw = storage.getItem(SSO_SUCCESS_KEY)
  if (raw === null) {
    return null
  }
  try {
    const value = JSON.parse(raw) as { ssoRequestId?: unknown; confirmedAt?: unknown }
    if (
      typeof value.ssoRequestId !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(value.ssoRequestId)
      || typeof value.confirmedAt !== 'number'
      || !Number.isSafeInteger(value.confirmedAt)
      || now - value.confirmedAt < 0
      || now - value.confirmedAt > 5 * 60 * 1000
    ) {
      storage.removeItem(SSO_SUCCESS_KEY)
      return null
    }
    return { ssoRequestId: value.ssoRequestId, confirmedAt: value.confirmedAt }
  } catch {
    storage.removeItem(SSO_SUCCESS_KEY)
    return null
  }
}
