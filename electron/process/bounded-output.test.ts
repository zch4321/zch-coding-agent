import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BoundedProcessOutput } from './bounded-output'

describe('BoundedProcessOutput', () => {
  it('keeps a fixed-size head and tail while hashing every discarded byte', () => {
    const output = new BoundedProcessOutput(5)
    output.append('stdout', 'abcd')
    output.append('stderr', 'efgh')

    expect(output.snapshot()).toEqual({
      stdout: 'ab',
      stderr: 'fgh',
      truncated: true,
      totalBytes: 8,
      stdoutBytes: 4,
      stderrBytes: 4,
      discardedHash: createHash('sha256').update('cde').digest('hex'),
    })
  })

  it('does not report a discarded hash when output fits', () => {
    const output = new BoundedProcessOutput(32)
    output.append('stdout', 'ok')

    expect(output.snapshot()).toMatchObject({
      stdout: 'ok',
      stderr: '',
      truncated: false,
      totalBytes: 2,
    })
    expect(output.snapshot()).not.toHaveProperty('discardedHash')
  })
})
