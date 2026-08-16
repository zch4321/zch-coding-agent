import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { compileSchema } from '../schema-validator'
import { normalizeToolInput } from './tool-input-normalizer'

describe('tool input normalization', () => {
  const schema = Type.Object(
    {
      path: Type.String(),
      count: Type.Integer({ minimum: 1, maximum: 10 }),
      enabled: Type.Boolean(),
      labels: Type.Array(Type.String()),
      nested: Type.Object(
        { limit: Type.Number() },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  )

  it('drops undeclared fields and coerces unambiguous scalar values recursively', () => {
    expect(
      normalizeToolInput(schema, {
        path: 42,
        count: '5',
        enabled: 'FALSE',
        labels: [1, true],
        nested: { limit: '2.5', ignored: 'remove me' },
        hallucinated: 'remove me',
      }),
    ).toEqual({
      path: '42',
      count: 5,
      enabled: false,
      labels: ['1', 'true'],
      nested: { limit: 2.5 },
    })
  })

  it('does not guess object, array, null, or ambiguous boolean conversions', () => {
    const normalized = normalizeToolInput(schema, {
      path: null,
      count: true,
      enabled: 1,
      labels: 'one',
      nested: '{"limit":2}',
    })
    expect(normalized).toEqual({
      path: null,
      count: true,
      enabled: 1,
      labels: 'one',
      nested: '{"limit":2}',
    })
    expect(compileSchema(schema)(normalized)).toBe(false)
  })

  it('selects a literal union branch without changing an already valid type', () => {
    const union = Type.Object(
      {
        mode: Type.Union([Type.Literal('shell'), Type.Literal('process')]),
      },
      { additionalProperties: false },
    )
    expect(normalizeToolInput(union, { mode: 'shell', extra: true })).toEqual({
      mode: 'shell',
    })
  })
})
