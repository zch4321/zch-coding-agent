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
]

function currentLineStart(value: string, cursor: number): number {
  return value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
}

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

  const contextMatch = /(^|\s)@([^\s@]*)$/u.exec(beforeCursor)
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

export function replaceComposerRange(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return value.slice(0, start) + replacement + value.slice(end)
}

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

export function formatWorkspaceSuggestionPath(
  directory: string,
  name: string,
): string {
  return directory === '.' ? name : `${directory.replace(/\/$/u, '')}/${name}`
}

export function formatWorkspaceExpansionPath(path: string): string {
  return `${path.replace(/\/+$/u, '')}/`
}
