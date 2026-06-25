import { FormatRegistry, type TSchema } from '@sinclair/typebox'
import { Value, type ValueError } from '@sinclair/typebox/value'

export interface WorkbenchSchemaError {
  instancePath: string
  message?: string
}

export type WorkbenchValidateFunction = ((data: unknown) => boolean) & {
  errors: WorkbenchSchemaError[] | null
}

FormatRegistry.Set('date-time', (value) => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && value.includes('T')
})

/**
 * Renderer-side schema validation that mirrors the main-process
 * `electron/schema-validator` without using Ajv's runtime code generation.
 * The renderer CSP intentionally disallows `unsafe-eval`, and Ajv's default
 * compiler uses `new Function()`, so imported conversations are checked with
 * TypeBox's interpreted Value API before they enter UI state.
 */
export function compileWorkbenchSchema(
  schema: TSchema,
): WorkbenchValidateFunction {
  const validate = ((data: unknown) => {
    const errors = [...Value.Errors(schema, data)].map(formatValueError)
    validate.errors = errors.length > 0 ? errors : null
    return errors.length === 0
  }) as WorkbenchValidateFunction
  validate.errors = null
  return validate
}

function formatValueError(error: ValueError): WorkbenchSchemaError {
  return {
    instancePath: error.path || '/',
    message: error.message,
  }
}

export function formatWorkbenchSchemaErrors(
  errors: WorkbenchSchemaError[] | null | undefined,
): string {
  if (!errors?.length) return 'Schema validation failed'
  return errors
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    )
    .join('; ')
}
