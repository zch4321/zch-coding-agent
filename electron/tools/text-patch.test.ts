import { describe, expect, it } from 'vitest'
import { applyTextPatch } from './text-patch'

describe('strict text patch', () => {
  it('applies multiple exact hunks', () => {
    const patch = [
      '--- a/note.txt',
      '+++ b/note.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+bravo',
      '@@ -4,2 +4,2 @@',
      ' delta',
      '-echo',
      '+epsilon',
    ].join('\n')

    expect(
      applyTextPatch('alpha\nbeta\ncharlie\ndelta\necho\n', patch, 'note.txt'),
    ).toEqual({
      content: 'alpha\nbravo\ncharlie\ndelta\nepsilon\n',
      hunks: 2,
      addedLines: 2,
      removedLines: 2,
    })
  })

  it('preserves CRLF line endings', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma'].join('\n')

    expect(applyTextPatch('alpha\r\nbeta\r\n', patch, 'note.txt').content).toBe(
      'alpha\r\ngamma\r\n',
    )
  })

  it('rejects path mismatches and stale context', () => {
    expect(() =>
      applyTextPatch(
        'alpha\nbeta\n',
        [
          '--- a/other.txt',
          '+++ b/other.txt',
          '@@ -1 +1 @@',
          '-alpha',
          '+a',
        ].join('\n'),
        'note.txt',
      ),
    ).toThrow('header path')

    expect(() =>
      applyTextPatch(
        'changed\nbeta\n',
        ['@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma'].join('\n'),
        'note.txt',
      ),
    ).toThrow('does not match')
  })
})
