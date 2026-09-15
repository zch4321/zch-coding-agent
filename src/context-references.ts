import MarkdownIt from 'markdown-it'
import type { ContextAttachmentChip } from '../shared/context'

type ContextPath = Pick<ContextAttachmentChip, 'kind' | 'path'>

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '') || '.'
}

function reference(path: string): ContextAttachmentChip | undefined {
  if (
    !path ||
    path.length > 4096 ||
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return undefined
  const kind = path.replace(/\\/gu, '/').endsWith('/') ? 'directory' : 'file'
  const normalized = normalizePath(path)
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(normalized)) return undefined
  return {
    kind,
    path:
      kind === 'directory'
        ? normalized.replace(/\/+$/u, '') || '/'
        : normalized,
    source: 'mention',
  }
}

/** Encodes one workspace reference as editable text, including spaces and literal braces. */
export function formatContextReference(attachment: ContextPath): string {
  const path = normalizePath(attachment.path).replace(/\/+$/u, '') || '/'
  return `@{${path.replace(/[{}]/gu, '\\$&')}${attachment.kind === 'directory' && !path.endsWith('/') ? '/' : ''}}`
}

function readReference(
  source: string,
  start: number,
):
  | {
      attachment: ContextAttachmentChip
      end: number
    }
  | undefined {
  if (source[start] !== '@') return undefined
  if (source[start + 1] === '{') {
    let path = ''
    for (
      let index = start + 2;
      index < Math.min(source.length, start + 8196);
      index++
    ) {
      const char = source[index]!
      if (char === '}') {
        const attachment = reference(path)
        return attachment ? { attachment, end: index + 1 } : undefined
      }
      if (char === '{' || char === '\n' || char === '\r') return undefined
      if (char === '\\' && /[{}\\]/u.test(source[index + 1] ?? '')) {
        path += source[++index]
      } else {
        path += char
      }
    }
    return undefined
  }
  // Keep manually typed @path references; selected paths always use the delimited form.
  if (start > 0 && !/\s/u.test(source[start - 1]!)) return undefined
  const raw = /^@([^\s@{}<>`"']+)/u.exec(source.slice(start))?.[1]
  const path = raw?.replace(/[.,;:!?，。；：！？、)\]]+$/u, '')
  const attachment = path ? reference(path) : undefined
  return attachment ? { attachment, end: start + path!.length + 1 } : undefined
}

/** Adds opt-in inline references to Markdown without interpreting code, escapes or link destinations. */
export function contextReferencePlugin(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('link', 'context_reference', (state, silent) => {
    // markdown-it tracks link nesting at runtime, but its published typings omit this field.
    if (
      !state.env.contextReferences ||
      Number(Reflect.get(state, 'linkLevel')) > 0
    )
      return false
    const parsed = readReference(state.src, state.pos)
    if (!parsed || parsed.end > state.posMax) return false
    if (!silent) {
      const token = state.push('code_inline', 'code', 0)
      token.content =
        parsed.attachment.path +
        (parsed.attachment.kind === 'directory' ? '/' : '')
      token.meta = { contextReference: parsed.attachment }
    }
    state.pos = parsed.end
    return true
  })
}

const parser = new MarkdownIt({ html: false, linkify: true }).use(
  contextReferencePlugin,
)

/** Derives deduplicated workspace references from prose using the same rules as message rendering. */
export function parseContextReferences(text: string): ContextAttachmentChip[] {
  const references = new Map<string, ContextAttachmentChip>()
  for (const block of parser.parse(text, { contextReferences: true })) {
    if (block.type !== 'inline') continue
    let linkDepth = 0
    for (const token of block.children ?? []) {
      if (token.type === 'link_open') linkDepth++
      if (token.type === 'link_close') linkDepth--
      const attachment = token.meta?.contextReference as
        | ContextAttachmentChip
        | undefined
      if (attachment && !linkDepth)
        references.set(`${attachment.kind}:${attachment.path}`, attachment)
    }
  }
  return [...references.values()]
}

/** Restores older separately stored selections into visible text without duplicating existing references. */
export function appendMissingContextReferences(
  text: string,
  attachments: readonly ContextPath[],
): string {
  if (!attachments.length) return text
  const existing = new Set(
    parseContextReferences(text).map((item) => `${item.kind}:${item.path}`),
  )
  const missing: string[] = []
  for (const attachment of attachments) {
    const formatted = formatContextReference(attachment)
    const normalized = parseContextReferences(formatted)[0]
    if (!normalized) continue
    const key = `${normalized.kind}:${normalized.path}`
    if (existing.has(key)) continue
    existing.add(key)
    missing.push(formatted)
  }
  return missing.length
    ? [text, missing.join(' ')].filter(Boolean).join('\n')
    : text
}
