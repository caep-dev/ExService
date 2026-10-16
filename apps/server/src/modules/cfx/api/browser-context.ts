import type { FastifyRequest } from 'fastify'
import type { CfxConfig } from '../config.js'
import type { CfxBrowserContext } from '../types.js'
import { CfxError } from '../errors.js'

function badRequest(): never { throw Object.assign(new Error('Invalid Cfx request.'), { statusCode: 400 }) }
export function cookieName(config: CfxConfig) { return config.enabled && config.mode === 'redirect' ? '__Host-exwebsite.cfx.browser' : 'exwebsite.cfx.browser' }

export function browserToken(request: Pick<FastifyRequest, 'headers'>, config: CfxConfig): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  if (typeof header !== 'string' || Buffer.byteLength(header) > 4096) return badRequest()
  const wanted = cookieName(config)
  let result: string | undefined
  for (const part of header.split(';')) {
    const text = part.trim()
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=("[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(text)
    if (!match) return badRequest()
    if (match[1] === wanted) {
      if (result !== undefined) return badRequest()
      result = match[2]!.replace(/^"|"$/g, '')
    }
  }
  return result
}

/** Future consumers call this with the real request, never a body-supplied binding. */
export function browserContext(request: FastifyRequest): CfxBrowserContext {
  const token = browserToken(request, request.server.cfxServices.config)
  if (!token) throw new CfxError('CFX_ATTEMPT_NOT_FOUND')
  return request.server.cfxServices.resolveBrowserContext({ bindingToken: token, clientIp: request.ip })
}

export function checkSource(request: FastifyRequest, config: CfxConfig, callback: boolean) {
  if (!config.enabled) throw new CfxError('CFX_DISABLED')
  if (callback) {
    if (config.mode !== 'redirect') throw new CfxError('CFX_FLOW_UNAVAILABLE')
    return
  }
  const origin = request.headers.origin
  const mutation = request.method === 'POST' || request.method === 'DELETE'
  if ((mutation && origin !== config.publicOrigin) || (!mutation && origin !== undefined && origin !== config.publicOrigin) ||
      request.headers['sec-fetch-site'] === 'cross-site') throw new CfxError('CFX_ORIGIN_FORBIDDEN')
}

export function checkRawQuery(request: FastifyRequest, callback: boolean) {
  const raw = (request.raw.url ?? '').split('?')[1] ?? ''
  if (/%(?![0-9a-f]{2})/i.test(raw)) return badRequest()
  const query = new URLSearchParams(raw), seen = new Set<string>()
  for (const key of query.keys()) {
    if (!callback || !['attemptId', 'payload'].includes(key) || seen.has(key)) return badRequest()
    seen.add(key)
  }
  if (!callback && raw) return badRequest()
}
