export type ComposerSuggestionTriggerKind = 'slash' | 'skill' | 'context'

export interface ComposerSuggestionTrigger {
  kind: ComposerSuggestionTriggerKind
  query: string
  replaceStart: number
  replaceEnd: number
}

export interface SlashCommandDefinition {
  command: string
  usage: string
}

export interface ComposerSuggestionItem {
  id: string
  label: string
  detail: string
  icon: 'file' | 'folder' | 'terminal' | 'app'
  replacement?: string
  expandTo?: string
  attachment?: {
    kind: 'file' | 'directory'
    path: string
  }
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: 'compact', usage: '/compact ' },
  { command: 'goal', usage: '/goal ' },
  { command: 'plan', usage: '/plan ' },
  { command: 'prompt', usage: '/prompt ' },
  { command: 'skill', usage: '/skill ' },
  { command: 'swarm', usage: '/swarm ' },
]

function currentLineStart(value: string, cursor: number): number {
  return value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
}

/** Finds the workspace token at the cursor and returns its replacement range and kind. */
export function detectComposerSuggestionTrigger(
  value: string,
  cursor: number,
): ComposerSuggestionTrigger | undefined {
  const safeCursor = Math.min(Math.max(cursor, 0), value.length)
  const lineStart = currentLineStart(value, safeCursor)
  const beforeCursor = value.slice(lineStart, safeCursor)
  const skillMatch = /^\/skill\s+([A-Za-z0-9_-]*)$/u.exec(beforeCursor)

  if (skillMatch) {
    const query = skillMatch[1] ?? ''
    return {
      kind: 'skill',
      query,
      replaceStart: safeCursor - query.length,
      replaceEnd: safeCursor,
    }
  }

  const slashMatch = /^\/([A-Za-z0-9_-]*)$/u.exec(beforeCursor)
  if (slashMatch) {
    return {
      kind: 'slash',
      query: slashMatch[1] ?? '',
      replaceStart: lineStart,
      replaceEnd: safeCursor,
    }
  }

  const referenceStart = value.lastIndexOf('@{', safeCursor - 1)
  if (referenceStart >= lineStart && referenceStart + 2 <= safeCursor) {
    let closing = -1
    let invalid = false
    for (let index = referenceStart + 2; index < value.length; index++) {
      if (value[index] === '\\' && /[{}\\]/u.test(value[index + 1] ?? '')) {
        index++
        continue
      }
      if (value[index] === '}') {
        closing = index
        break
      }
      if (value[index] === '{' || /[\r\n]/u.test(value[index]!)) {
        invalid = true
        break
      }
    }
    if (!invalid && (closing < 0 || safeCursor <= closing)) {
      return {
        kind: 'context',
        query: value
          .slice(referenceStart + 2, safeCursor)
          .replace(/\\([{}\\])/gu, '$1'),
        replaceStart: referenceStart,
        replaceEnd: closing < 0 ? safeCursor : closing + 1,
      }
    }
  }
  const contextMatch = /(^|\s)@([^\s@{}]*)$/u.exec(beforeCursor)
  if (contextMatch) {
    const query = contextMatch[2] ?? ''
    return {
      kind: 'context',
      query,
      replaceStart: safeCursor - query.length - 1,
      replaceEnd: safeCursor,
    }
  }

  return undefined
}

/** Replaces one composer token range while preserving text outside that range. */
export function replaceComposerRange(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return value.slice(0, start) + replacement + value.slice(end)
}

/** Splits a workspace suggestion token into a directory prefix and name filter. */
export function workspaceSuggestionQuery(token: string): {
  directory: string
  filter: string
} {
  const normalized = token.replace(/\\/gu, '/')
  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex === -1) {
    return { directory: '.', filter: normalized }
  }

  return {
    directory: normalized.slice(0, slashIndex) || '.',
    filter: normalized.slice(slashIndex + 1),
  }
}

/** Formats a workspace directory/name pair as a displayable suggestion path. */
export function formatWorkspaceSuggestionPath(
  directory: string,
  name: string,
): string {
  return directory === '.' ? name : `${directory.replace(/\/$/u, '')}/${name}`
}

/** Normalizes a workspace path and appends a separator for directory expansion. */
export function formatWorkspaceExpansionPath(path: string): string {
  return `${path.replace(/\/+$/u, '')}/`
}
