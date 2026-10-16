import { constants, createHash, generateKeyPair, privateDecrypt, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'
import { CfxError } from './errors.js'

export interface CfxKeys { publicKey: KeyObject; privateKey: KeyObject }
export function generateKeys(): Promise<CfxKeys> {
  return new Promise((resolve, reject) => generateKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey, privateKey) => {
    if (error) reject(new Error('Cfx key generation failed.')); else resolve({ publicKey, privateKey })
  }))
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const opaquePattern = /^[A-Za-z0-9_-]{43}$/
export const randomToken = () => randomBytes(32).toString('base64url')

export function decodePayload(payload: string): Buffer {
  if (typeof payload !== 'string' || payload.length < 1 || payload.length > 1024) throw new CfxError('CFX_INVALID_PAYLOAD')
  const compact = payload.replace(/[\t\n\v\f\r ]/g, '')
  if (!/^[A-Za-z0-9+/]{342}==$/.test(compact)) throw new CfxError('CFX_INVALID_PAYLOAD')
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length !== 256 || bytes.toString('base64') !== compact) throw new CfxError('CFX_INVALID_PAYLOAD')
  return bytes
}

export function decryptAuthorization(bytes: Buffer, privateKey: KeyObject, expectedNonce: string): string {
  let parsed: unknown
  try {
    const plaintext = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, bytes)
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) } finally { plaintext.fill(0) }
  } catch { throw new CfxError('CFX_INVALID_PAYLOAD') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CfxError('CFX_INVALID_PAYLOAD')
  const value = parsed as Record<string, unknown>
  if (typeof value.key !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(value.key) || typeof value.push !== 'boolean' ||
      typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(value.nonce)) throw new CfxError('CFX_INVALID_PAYLOAD')
  if (!timingSafeEqual(Buffer.from(value.nonce, 'hex'), Buffer.from(expectedNonce, 'hex'))) throw new CfxError('CFX_NONCE_INVALID')
  if (value.api !== 4) throw new CfxError('CFX_API_VERSION_UNSUPPORTED')
  return value.key
}
