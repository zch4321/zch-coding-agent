import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { TerminalIdSchema } from './ids'

describe('TerminalIdSchema', () => {
  const validate = new Ajv({ strict: true }).compile(TerminalIdSchema)

  it('accepts positive safe integers', () => {
    expect(validate(1)).toBe(true)
    expect(validate(65_536)).toBe(true)
    expect(validate(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('rejects strings, zero, negatives, decimals, and unsafe integers', () => {
    for (const value of [
      '1',
      'terminal:1',
      0,
      -2,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
    ]) {
      expect(validate(value)).toBe(false)
    }
  })
})
