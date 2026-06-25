import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_TITLE_AUTO_SLICE,
  CONVERSATION_TITLE_MAX,
  DEFAULT_CONVERSATION_TITLE,
  deriveAutoTitle,
  normalizeTitle,
} from './conversation-titles'

describe('conversation titles', () => {
  it('collapses whitespace and slices the auto title', () => {
    expect(deriveAutoTitle('  fix   the   bug  ')).toBe('fix the bug')
    const long = 'x'.repeat(200)
    expect(deriveAutoTitle(long)).toHaveLength(CONVERSATION_TITLE_AUTO_SLICE)
  })

  it('trims and caps a user-supplied title', () => {
    expect(normalizeTitle('  hello  ')).toBe('hello')
    const long = 'y'.repeat(300)
    expect(normalizeTitle(long)).toHaveLength(CONVERSATION_TITLE_MAX)
    expect(normalizeTitle('   ')).toBe('')
  })

  it('exposes a stable default title constant', () => {
    expect(DEFAULT_CONVERSATION_TITLE).toBe('New conversation')
  })
})
