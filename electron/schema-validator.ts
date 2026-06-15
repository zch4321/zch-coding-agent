import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { TSchema } from '@sinclair/typebox'

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

export function compileSchema<Schema extends TSchema>(
  schema: Schema,
): ValidateFunction {
  return createAjv().compile(schema)
}

export function formatSchemaErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors?.length) {
    return 'Schema validation failed'
  }

  return errors
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    )
    .join('; ')
}
