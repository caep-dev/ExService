import { Ajv, type ValidateFunction } from 'ajv'
import { readContract } from '../../../contract/document.js'
import type { components } from '@workspace/api-client/types'
import { AuthError } from '@server/src/modules/auth/errors.js'

export type JoinApplicationInput = components['schemas']['JoinApplicationPayload']
export type JoinForm = JoinApplicationInput['form']
type Schema = {
  $ref?: string
  type?: string
  const?: unknown
  enum?: unknown[]
  format?: string
  pattern?: string
  properties?: Record<string, Schema>
  oneOf?: Schema[]
}
let validators:
  | {
      payload: ValidateFunction<JoinApplicationInput>
      form: ValidateFunction<JoinForm>
      snapshot: ValidateFunction<components['schemas']['JoinIdentitySnapshot']>
      schemas: Record<string, Schema>
    }
  | undefined

function contract() {
  if (validators) return validators
  const source = readContract()
  const schemas = source.components?.schemas
  if (
    !schemas?.JoinApplicationPayload ||
    !schemas.JoinNewForm ||
    !schemas.JoinExperiencedForm ||
    !schemas.JoinIdentitySnapshot
  )
    throw new Error('Join application Contract schemas are missing')
  const definitions = JSON.parse(
    JSON.stringify(schemas).replaceAll('#/components/schemas/', '#/definitions/'),
  ) as Record<string, Schema>
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  })
  ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/)
  const compile = <T>(schema: object) => ajv.compile<T>({ ...schema, definitions })
  validators = {
    schemas,
    payload: compile<JoinApplicationInput>({
      $ref: '#/definitions/JoinApplicationPayload',
    }),
    snapshot: compile<components['schemas']['JoinIdentitySnapshot']>({
      $ref: '#/definitions/JoinIdentitySnapshot',
    }),
    form: compile<JoinForm>({
      oneOf: [{ $ref: '#/definitions/JoinNewForm' }, { $ref: '#/definitions/JoinExperiencedForm' }],
    }),
  }
  return validators
}
function resolve(schema: Schema): Schema {
  return schema.$ref ? contract().schemas[schema.$ref.split('/').at(-1)!]! : schema
}
function normalize(value: unknown, schema: Schema, name?: string): unknown {
  if (schema.$ref) return normalize(value, resolve(schema), schema.$ref.split('/').at(-1))
  if (
    typeof value === 'string' &&
    schema.type === 'string' &&
    (name === 'Email' ||
      name === 'Nickname' ||
      (!schema.enum && schema.const === undefined && !schema.format && !schema.pattern))
  ) {
    return name === 'Email' ? value.trim().toLowerCase() : value.trim()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const object = value as Record<string, unknown>
  if (schema.oneOf) {
    const branch = schema.oneOf.find((candidate) => {
      const properties = resolve(candidate).properties
      return (
        properties &&
        Object.entries(properties).some(
          ([key, property]) =>
            resolve(property).const !== undefined && object[key] === resolve(property).const,
        )
      )
    })
    if (branch) return normalize(value, branch)
    return schema.oneOf.reduce(
      (current, candidate) => normalize(current, candidate),
      value as unknown,
    )
  }
  const result = { ...object }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(object, key)) result[key] = normalize(object[key], property)
  }
  return result
}
/** Retains undeclared keys so the Contract validator can reject them. */
export function normalizeJoinApplicationPayload(value: unknown): unknown {
  return normalize(value, contract().schemas.JoinApplicationPayload!)
}
function validBirthDate(value: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= new Date(now).toISOString().slice(0, 10)
  )
}
export function validateJoinApplicationPayload(value: unknown, now: number): JoinApplicationInput {
  const normalized = normalizeJoinApplicationPayload(value)
  if (!contract().payload(normalized) || !validBirthDate(normalized.form.birthDate, now))
    throw new AuthError('BAD_REQUEST')
  return normalized
}
/** Stored version 1 data never falls back to legacy or gets repaired on reads. */
export function validateStoredJoinForm(value: unknown, now: number): JoinForm {
  if (!contract().form(value) || !validBirthDate(value.birthDate, now))
    throw new Error('Stored join application form is invalid')
  if (
    JSON.stringify(
      normalize(
        value,
        value.applicationType === 'new'
          ? contract().schemas.JoinNewForm!
          : contract().schemas.JoinExperiencedForm!,
      ),
    ) !== JSON.stringify(value)
  )
    throw new Error('Stored join application form is not normalized')
  return value
}
export function validateIdentitySnapshot(
  value: unknown,
): components['schemas']['JoinIdentitySnapshot'] | null {
  if (value === null) return null
  if (!contract().snapshot(value)) throw new Error('Stored join identity snapshot is invalid')
  return value
}
