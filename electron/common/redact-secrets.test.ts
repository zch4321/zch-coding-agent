import { describe, expect, it } from 'vitest'
import {
  redactJsonSecrets,
  redactTextSecrets,
  StreamingSecretRedactor,
} from './redact-secrets'

describe('literal secret redaction', () => {
  it.each([
    ['abc', ['abc'], '[redacted]'],
    ['abcd!', ['abc', 'bcd'], '[redacted]!'],
    ['ababab!', ['aba', 'bab'], '[redacted]!'],
    [
      'key.x key.xy key.xyz',
      ['key.xy', 'key.x', 'key.xyz'],
      '[redacted] [redacted] [redacted]',
    ],
    ['雪😀/雪', ['雪😀', '雪'], '[redacted]/[redacted]'],
    ['x/xy/xyz', ['x', 'xy', 'xyz', ''], '[redacted]/[redacted]/[redacted]'],
  ] as const)(
    'matches %s independently of chunk boundaries',
    (value, secrets, expected) => {
      expect(redactTextSecrets(value, secrets)).toBe(expected)
      for (let split = 0; split <= value.length; split += 1) {
        const stream = new StreamingSecretRedactor(secrets)
        expect(
          stream.append(value.slice(0, split)) +
            stream.append(value.slice(split)) +
            stream.finish(),
        ).toBe(expected)
      }
      const stream = new StreamingSecretRedactor(secrets)
      expect(
        value
          .split('')
          .map((chunk) => stream.append(chunk))
          .join('') + stream.finish(),
      ).toBe(expected)
    },
  )

  it('never releases an undecided prefix, but immediately releases ordinary text', () => {
    const stream = new StreamingSecretRedactor(['credential-雪😀'])
    expect(stream.append('log: ')).toBe('log: ')
    for (const character of 'credential-雪')
      expect(stream.append(character)).toBe('')
    expect(stream.append('😀')).toBe('[redacted]')
    expect(stream.append(' complete')).toBe(' complete')
    expect(stream.finish()).toBe('')
  })

  it('flushes harmless incomplete prefixes at EOF and isolates JSON string boundaries', () => {
    const stream = new StreamingSecretRedactor(['abcd'])
    expect(stream.append('ab')).toBe('')
    expect(stream.finish()).toBe('ab')
    expect(stream.append('cd')).toBe('cd')
    const value = { text: 'abcd', nested: ['ab', 'cd', 2, null, true] }
    expect(redactJsonSecrets(value, ['abcd'])).toEqual({
      ...value,
      text: '[redacted]',
    })
    expect(value.text).toBe('abcd')
  })
})
