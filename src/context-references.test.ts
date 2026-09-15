import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import {
  appendMissingContextReferences,
  contextReferencePlugin,
  formatContextReference,
  parseContextReferences,
} from './context-references'

describe('inline workspace references', () => {
  it('round-trips files and directories with spaces, Unicode, braces and Windows separators', () => {
    for (const kind of ['file', 'directory'] as const) {
      const path = 'docs/设计 {draft}/release notes.md'
      const text = formatContextReference({
        kind,
        path: path.replaceAll('/', '\\'),
      })
      expect(text).toBe(
        `@{docs/设计 \\{draft\\}/release notes.md${kind === 'directory' ? '/' : ''}}`,
      )
      expect(parseContextReferences(`检查${text}，谢谢。`)).toEqual([
        { kind, path, source: 'mention' },
      ])
    }
    expect(parseContextReferences('@{./}')).toEqual([
      { kind: 'directory', path: '.', source: 'mention' },
    ])
  })

  it('deduplicates attachments while retaining each visible occurrence', () => {
    const text = 'Compare @{src/a.ts} with @src/a.ts and @{src/}.'
    expect(parseContextReferences(text)).toEqual([
      { kind: 'file', path: 'src/a.ts', source: 'mention' },
      { kind: 'directory', path: 'src', source: 'mention' },
    ])
    const markdown = new MarkdownIt({ html: false }).use(contextReferencePlugin)
    expect(markdown.render(text, { contextReferences: true })).toBe(
      '<p>Compare <code>src/a.ts</code> with <code>src/a.ts</code> and <code>src/</code>.</p>\n',
    )
    expect(markdown.render(text)).toContain('@{src/a.ts}')
  })

  it('does not attach examples, escaped placeholders, links, images or incomplete references', () => {
    const text = [
      '`@{inline.ts}` and `@bare.ts`',
      '```ts\n@{fenced.ts}\n```',
      '    @{indented.ts}',
      '\\@{escaped.ts} \\@escaped-bare.ts',
      '[label @{label.ts}](https://example.com/@{url.ts})',
      '![alt @{image.ts}](https://example.com/image.png)',
      'person@example.com @https://example.com @{https://example.com/a}',
      '@{} @{unfinished\n@{bad{brace}.ts}\n@{line\nbreak.ts}',
    ].join('\n\n')
    expect(parseContextReferences(text)).toEqual([])
  })

  it('escapes display content and restores older metadata only once', () => {
    const attachment = {
      kind: 'file' as const,
      path: '<img onerror=alert(1)>.md',
    }
    const text = formatContextReference(attachment)
    const markdown = new MarkdownIt({ html: false }).use(contextReferencePlugin)
    const html = markdown.render(text, { contextReferences: true })
    expect(html).toContain('&lt;img onerror=alert(1)&gt;.md')
    expect(html).not.toContain('<img')
    expect(
      appendMissingContextReferences('Review', [attachment, attachment]),
    ).toBe(`Review\n${text}`)
    expect(appendMissingContextReferences(`Review ${text}`, [attachment])).toBe(
      `Review ${text}`,
    )
  })
})
