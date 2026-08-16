import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { TSchema } from '@sinclair/typebox'

/** Creates a strict AJV instance configured for the repository's TypeBox schemas. */
export function createAjv(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
  })

  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => {
      const timestamp = Date.parse(value)
      return Number.isFinite(timestamp) && value.includes('T')
    },
  })

  return ajv
}

/** Compiles a TypeBox schema into a reusable strict validator. */
export function compileSchema<Schema extends TSchema>(
  schema: Schema,
): ValidateFunction {
  return createAjv().compile(schema)
}

/** Formats AJV validation errors into a bounded human-readable message. */
export function formatSchemaErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors?.length) {
    return 'Schema validation failed'
  }

  return errors.map(formatSchemaError).join('; ')
}

function formatSchemaError(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') {
    return `${propertyPath(error.instancePath, error.params.additionalProperty)} is not a recognized parameter`
  }
  if (error.keyword === 'required') {
    return `${propertyPath(error.instancePath, error.params.missingProperty)} is required`
  }
  if (error.keyword === 'type') {
    return `${error.instancePath || '/'} must be ${String(error.params.type)}`
  }
  return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
}

function propertyPath(instancePath: string, property: unknown): string {
  if (typeof property !== 'string' || !property) return instancePath || '/'
  const escaped = property.replaceAll('~', '~0').replaceAll('/', '~1')
  return `${instancePath}/${escaped}`
}
