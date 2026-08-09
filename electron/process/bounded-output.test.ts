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

  it('falls back from invalid UTF-8 to the configured Windows encoding', () => {
    const output = new BoundedProcessOutput(64, 'gb18030')
    output.append('stderr', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))

    expect(output.snapshot().stderr).toBe('中文')
  })

  it('detects legacy bytes after a long ASCII prefix', () => {
    const output = new BoundedProcessOutput(32_768, 'gb18030')
    output.append('stdout', 'a'.repeat(20_000))
    output.append('stdout', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))

    expect(output.snapshot().stdout).toBe(`${'a'.repeat(20_000)}中文`)
  })

  it('keeps valid UTF-8 even when a legacy fallback is configured', () => {
    const output = new BoundedProcessOutput(64, 'gb18030')
    output.append('stdout', Buffer.from('UTF-8 中文'))

    expect(output.snapshot().stdout).toBe('UTF-8 中文')
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
