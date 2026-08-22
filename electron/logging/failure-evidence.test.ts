import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTraceFailureEvidence } from './failure-evidence'

describe('createTraceFailureEvidence', () => {
  it('bounds UTF-8 evidence while hashing the complete payload', () => {
    const source = `prefix-${'界'.repeat(100_000)}`
    const evidence = createTraceFailureEvidence('invalid_json', source)

    expect(evidence.observedBytes).toBe(Buffer.byteLength(source, 'utf8'))
    expect(evidence.capturedBytes).toBeLessThanOrEqual(256 * 1_024)
    expect(Buffer.byteLength(evidence.content, 'utf8')).toBe(
      evidence.capturedBytes,
    )
    expect(evidence.truncated).toBe(true)
    expect(evidence.sha256).toBe(
      createHash('sha256').update(source).digest('hex'),
    )
  })

  it('never replaces a multibyte character split by the byte boundary', () => {
    const prefix = 'x'.repeat(256 * 1_024 - 1)
    const evidence = createTraceFailureEvidence(
      'invalid_completion',
      `${prefix}界`,
    )

    expect(evidence.content).toBe(prefix)
    expect(evidence.content).not.toContain('\uFFFD')
    expect(evidence.capturedBytes).toBe(Buffer.byteLength(prefix, 'utf8'))
    expect(evidence.truncated).toBe(true)
  })
})
