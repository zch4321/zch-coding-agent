import { describe, expect, it, vi } from 'vitest'
import {
  markdownSectionPreview,
  parseMarkdownSections,
  renderMarkdownSection,
} from './markdown'
import * as code from './markdown-code'

describe('streaming Markdown sections', () => {
  it.each([
    ['```ts\nconst n = 1\n```', true],
    ['```ts\nconst n = 1', false],
    ['~~~~ts\nconst n = 1\n~~~', false],
    ['~~~~ts\nconst n = 1\n~~~~~', true],
    ['> ```ts\n> const n = 1\n> ```', true],
    ['> ```ts\n> const n = 1\n\nOutside', false],
    ['- item\n\n  ```ts\n  const n = 1\n  ```', true],
    ['```\n```', true],
  ])(
    'recognizes a closing fence using parser structure: %s',
    (source, closed) => {
      const fences = parseMarkdownSections(source).flatMap(
        (section) => section.fences,
      )
      expect(fences).toHaveLength(1)
      expect(fences[0]?.closed).toBe(closed)
    },
  )

  it('retains finished sections and reparses reference links when later definitions arrive', () => {
    const source = '# Title\n\n```text\nunchanged\n```\n\nA growing paragraph'
    const first = parseMarkdownSections(source)
    const next = parseMarkdownSections(source + ' continues', first)
    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(next[2]).not.toBe(first[2])
    const reference = parseMarkdownSections('[link][target]')
    const resolved = parseMarkdownSections(
      '[link][target]\n\n[target]: https://example.com',
      reference,
    )
    expect(resolved[0]).not.toBe(reference[0])
    expect(resolved[0]?.html).toContain('href="https://example.com"')
  })

  it('keeps streaming open code plain and preserves escaping and literal replacement markers', async () => {
    const render = vi
      .spyOn(code, 'renderCode')
      .mockResolvedValue('<pre>colored</pre>')
    try {
      const open = parseMarkdownSections(
        '```ts\nconst html = "<script>$&</script>"',
      )[0]!
      const preview = await renderMarkdownSection(open, true)
      expect(render).not.toHaveBeenCalled()
      expect(preview).toContain('&lt;script&gt;$&amp;&lt;/script&gt;')
      await renderMarkdownSection(open, false)
      expect(render).toHaveBeenCalledTimes(1)
      const unsafe = parseMarkdownSections(
        '<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
      )
      const html = unsafe
        .map((section) => markdownSectionPreview(section))
        .join('')
      expect(html).not.toContain('<script>')
      expect(html).not.toContain('href="javascript:')
      const literal = parseMarkdownSections(
        '@@SHIKI_FENCE_0@@\n\n```text\n$&\n```',
      )
      expect(
        literal.map((section) => markdownSectionPreview(section)).join(''),
      ).toContain('@@SHIKI_FENCE_0@@')
      expect(
        literal.map((section) => markdownSectionPreview(section)).join(''),
      ).toContain('$&amp;')
    } finally {
      render.mockRestore()
    }
  })
})
