import { createApiClient } from '@workspace/api-client'
import { createExAxios } from '@workspace/sdk/http/browser'
import { bindSessionHttp, syncSessionToken } from '@web/src/auth/storage'

/**
 * 前端唯一的 API base URL 来源。
 *
 * - 开发期缺省 `/api`，由 Vite 代理到本仓库唯一的 Server（`127.0.0.1:8080`）。
 * - `VITE_API_BASE_URL` 可覆盖浏览器请求的 API 前缀，业务调用仍通过共享 Client。
 *
 * 使用 `||` 而不是 `??`：设置为空字符串（例如 `VITE_API_BASE_URL=`）时同样回退到 `/api`，
 * 否则 `createApiClient` 会在模块加载阶段抛错，前端直接白屏。
 */
const pageOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
const baseUrl: string = new URL(import.meta.env.VITE_API_BASE_URL || '/api', pageOrigin).href.replace(/\/$/, '')

export const http = createExAxios({
  baseUrl,
  websiteBaseUrl: baseUrl,
  sameOriginCookies: true,
  onSessionExpired: () => {
    if (syncSessionToken() !== null) return
    if (window.location.pathname === '/support' || window.location.pathname.startsWith('/support/')) return
    if (window.location.pathname.startsWith('/identity/')) return
    if (window.location.pathname === '/login' && new URLSearchParams(window.location.search).has('ssoRequestId')) return
    if (window.location.pathname !== '/login') window.location.replace('/login')
  },
})
bindSessionHttp(token => http.setToken(token))
export const api = createApiClient({ baseUrl, transport: request => http(request) })

/** Revoke only the session being replaced without redirecting the caller's in-place flow. */
export async function revokePreviousSessionForReplacement(oldToken: string): Promise<void> {
  const replacementHttp = createExAxios({
    baseUrl,
    websiteBaseUrl: baseUrl,
    sameOriginCookies: true,
    onSessionExpired: () => { syncSessionToken() },
  })
  replacementHttp.setToken(oldToken)
  const replacementApi = createApiClient({ baseUrl, transport: request => replacementHttp(request) })
  await replacementApi.POST('/auth/logout', {
    headers: { Authorization: `Bearer ${oldToken}` },
    alert: false,
  })
}
