import type { PathGuard } from '../agent/path-guard'

export interface SearchMatch {
  path: string
  line: number
  text: string
}

export interface SearchOutcome {
  matches: SearchMatch[]
  truncated: boolean
}

export interface SearchInput {
  pattern: string
  caseSensitive: boolean
  guard: PathGuard
  rootInput: string
  include: string
  maxResults: number
  signal: AbortSignal
}

/**
 * Workspace-scoped text search. Implementations own the file walk, glob
 * filtering and matching, but must keep results inside the workspace and
 * surface only files that the caller could read with filesystem.read tools.
 */
export interface Searcher {
  readonly backend: 'ripgrep' | 'javascript'
  search(input: SearchInput): Promise<SearchOutcome>
}
