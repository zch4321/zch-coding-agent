import { createHash } from 'node:crypto'
import type { TraceFailureEvidence } from './events'

const MAX_FAILURE_EVIDENCE_BYTES = 256 * 1_024

/** Builds a bounded failure payload with byte counts and a full-content hash. */
export function createTraceFailureEvidence(
  kind: TraceFailureEvidence['kind'],
  value: string,
): TraceFailureEvidence {
  const source = Buffer.from(value, 'utf8')
  let capturedEnd = Math.min(source.byteLength, MAX_FAILURE_EVIDENCE_BYTES)
  if (capturedEnd < source.byteLength) {
    while (
      capturedEnd > 0 &&
      (source[capturedEnd]! & 0b1100_0000) === 0b1000_0000
    ) {
      capturedEnd -= 1
    }
  }
  const captured = source.subarray(0, capturedEnd)
  const content = captured.toString('utf8')
  return {
    kind,
    content,
    observedBytes: source.byteLength,
    capturedBytes: Buffer.byteLength(content, 'utf8'),
    truncated: source.byteLength > captured.byteLength,
    sha256: createHash('sha256').update(source).digest('hex'),
  }
}
