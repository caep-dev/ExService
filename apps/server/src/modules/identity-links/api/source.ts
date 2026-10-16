import type { FastifyRequest } from 'fastify'
export interface TrustedBrowserOptions {
  publicOrigin: string
  production: boolean
}
export function checkOrigin(request: FastifyRequest, publicOrigin: string) {
  const mutation = request.method !== 'GET' && request.method !== 'HEAD'
  if (
    (mutation && request.headers.origin !== publicOrigin) ||
    (!mutation && request.headers.origin !== undefined && request.headers.origin !== publicOrigin) ||
    request.headers['sec-fetch-site'] === 'cross-site'
  )
    throw Object.assign(new Error('Origin forbidden'), { statusCode: 403 })
}
export function validateOrigin(options: TrustedBrowserOptions) {
  const url = new URL(options.publicOrigin)
  if (
    url.origin !== options.publicOrigin ||
    !['http:', 'https:'].includes(url.protocol) ||
    (options.production && url.protocol !== 'https:')
  )
    throw new Error('Invalid trusted public origin')
}
