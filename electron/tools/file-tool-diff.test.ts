import { describe, expect, it } from 'vitest'
import { createFileDiff, isFileDiffTruncated } from './file-tool-diff'
import { MAX_DIFF_CHARS } from './file-tool-limits'

describe('file tool diff bounds', () => {
  it('keeps the truncation marker inside the configured character limit', () => {
    const diff = createFileDiff(
      'large.txt',
      `${'before\n'.repeat(20_000)}tail`,
      'after',
    )

    expect(diff.length).toBe(MAX_DIFF_CHARS)
    expect(isFileDiffTruncated(diff)).toBe(true)
  })
})
