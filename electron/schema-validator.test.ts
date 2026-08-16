import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { compileSchema, formatSchemaErrors } from './schema-validator'

describe('schema error formatting', () => {
  it('names unknown and missing parameters by JSON pointer', () => {
    const validate = compileSchema(
      Type.Object({ expected: Type.String() }, { additionalProperties: false }),
    )
    expect(validate({ unexpected: true })).toBe(false)
    expect(formatSchemaErrors(validate.errors)).toContain(
      '/unexpected is not a recognized parameter',
    )
    expect(formatSchemaErrors(validate.errors)).toContain(
      '/expected is required',
    )
  })
})
