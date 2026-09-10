import MarkdownIt from 'markdown-it'
import { cachedCodeHtml, plainCodeHtml, renderCode } from './markdown-code'

export { renderCode } from './markdown-code'

export interface MarkdownFence {
  marker: string
  code: string
  language: string
  closed: boolean
}

export interface MarkdownSection {
  id: string
  html: string
  fences: MarkdownFence[]
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
markdown.validateLink = (url) => {
  const normalized = url.trim().toLowerCase()
  return ['https://', 'http://', 'mailto:', '#'].some((prefix) =>
    normalized.startsWith(prefix),
  )
}

markdown.renderer.rules.fence = (tokens, index, _options, env) => {
  const fences = env.fences as MarkdownFence[]
  const token = tokens[index]
  const lines = token.content
    ? token.content.split('\n').length - (token.content.endsWith('\n') ? 1 : 0)
    : 0
  // Source maps include the closing delimiter only when the parser found one,
  // including fences nested in lists and blockquotes.
  const closed = Boolean(token.map && token.map[1] - token.map[0] > lines + 1)
  const marker = `<pre data-markdown-fence="${fences.length}"></pre>`
  fences.push({
    marker,
    code: token.content,
    language: token.info.trim().split(/\s+/)[0] || 'text',
    closed,
  })
  return marker
}

markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index]
  if (token.attrIndex('href') >= 0) {
    token.attrSet('rel', 'noreferrer noopener')
    token.attrSet('target', '_blank')
  }
  return self.renderToken(tokens, index, options)
}

/** Parses the complete Markdown document while retaining unchanged top-level render sections. */
export function parseMarkdownSections(
  source: string,
  previous: readonly MarkdownSection[] = [],
): MarkdownSection[] {
  const env: { fences: MarkdownFence[] } = { fences: [] }
  const tokens = markdown.parse(source, env)
  const old = new Map(previous.map((section) => [section.id, section]))
  const sections: MarkdownSection[] = []
  for (let start = 0; start < tokens.length; ) {
    let end = start + 1
    let depth = tokens[start]!.nesting
    while (depth > 0 && end < tokens.length) depth += tokens[end++]!.nesting
    env.fences = []
    const html = markdown.renderer.render(
      tokens.slice(start, end),
      markdown.options,
      env,
    )
    const id = `${tokens[start]!.map?.[0] ?? start}:${tokens[start]!.type}`
    const section = { id, html, fences: env.fences }
    const existing = old.get(id)
    sections.push(
      existing &&
        existing.html === html &&
        existing.fences.length === section.fences.length &&
        existing.fences.every((fence, index) => {
          const next = section.fences[index]!
          return (
            fence.code === next.code &&
            fence.language === next.language &&
            fence.closed === next.closed
          )
        })
        ? existing
        : section,
    )
    start = end
  }
  return sections
}

/** Resolves code placeholders using cached highlighting or escaped plain code. */
export function markdownSectionPreview(
  section: MarkdownSection,
  streaming = false,
): string {
  let html = section.html
  for (const fence of section.fences) {
    html = html.replace(fence.marker, () =>
      streaming && !fence.closed
        ? plainCodeHtml(fence.code)
        : (cachedCodeHtml(fence.code, fence.language) ??
          plainCodeHtml(fence.code)),
    )
  }
  return html
}

/** Highlights finished fences while retaining the plain preview for a streaming open fence. */
export async function renderMarkdownSection(
  section: MarkdownSection,
  streaming = false,
): Promise<string> {
  let html = section.html
  for (const fence of section.fences) {
    const rendered =
      streaming && !fence.closed
        ? plainCodeHtml(fence.code)
        : await renderCode(fence.code, fence.language)
    html = html.replace(fence.marker, () => rendered)
  }
  return html
}

/** Renders a complete document using the same safe, cached section renderer as the chat UI. */
export async function renderMarkdown(source: string): Promise<string> {
  return (
    await Promise.all(
      parseMarkdownSections(source).map((section) =>
        renderMarkdownSection(section),
      ),
    )
  ).join('')
}
