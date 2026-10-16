import { createHash, randomBytes } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { AuthError } from '../../auth/errors.js'
import { RegistrationError } from '../errors.js'
export { checkOrigin, validateOrigin } from '../../identity-links/api/source.js'
export type { TrustedBrowserOptions as RegistrationApiOptions } from '../../identity-links/api/source.js'
export function cookieName(production: boolean) {
  return production ? '__Host-exwebsite.registration.browser' : 'exwebsite.registration.browser'
}
export function registrationBrowser(request: FastifyRequest, production: boolean, create: boolean) {
  const header = request.headers.cookie
  let token: string | undefined
  if (header !== undefined) {
    if (typeof header !== 'string' || Buffer.byteLength(header) > 4096) throw new AuthError('BAD_REQUEST')
    for (const part of header.split(';')) {
      const match =
        /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=("[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.exec(
          part.trim(),
        )
      if (!match) throw new AuthError('BAD_REQUEST')
      if (match[1] === cookieName(production)) {
        if (token !== undefined) throw new AuthError('BAD_REQUEST')
        token = match[2]!.replace(/^"|"$/g, '')
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(token) ||
          Buffer.from(token, 'base64url').toString('base64url') !== token
        )
          throw new AuthError('BAD_REQUEST')
      }
    }
  }
  if (token === undefined) {
    if (!create) throw new RegistrationError('REGISTRATION_GRANT_INVALID')
    token = randomBytes(32).toString('base64url')
  }
  return {
    token,
    hash: createHash('sha256').update(`registration-browser:${token}`).digest('hex'),
    production,
  }
}
export function renewBrowser(request: FastifyRequest, reply: FastifyReply) {
  const browser = requireBrowser(request)
  reply.header(
    'Set-Cookie',
    `${cookieName(browser.production)}=${browser.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2400${browser.production ? '; Secure' : ''}`,
  )
}
export function requireBrowser(request: FastifyRequest) {
  if (!request.registrationBrowser) throw new RegistrationError('REGISTRATION_GRANT_INVALID')
  return request.registrationBrowser
}
