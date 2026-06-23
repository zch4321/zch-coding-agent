import { matchesGlob } from './glob'
import type { PathGuard } from './path-guard'
import { BoundedRegexSearcher } from './regex-search'
import { RipgrepSearcher } from './ripgrep-searcher'
import { walkFiles } from './workspace-walk'

const DEFAULT_GREP_FILE_BYTES = 256_000

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

/**
 * In-process fallback that mirrors the original grep behaviour: walk the
 * workspace, filter by include glob, and run a bounded worker-thread regex
 * over each file's content.
 */
export class JavaScriptSearcher implements Searcher {
  readonly backend = 'javascript' as const

  async search(input: SearchInput): Promise<SearchOutcome> {
    const {
      guard,
      rootInput,
      include,
      maxResults,
      signal,
      pattern,
      caseSensitive,
    } = input
    const walked = await walkFiles(guard, rootInput, maxResults * 10, signal)
    const matches: SearchMatch[] = []
    const searcher = new BoundedRegexSearcher()

    try {
      for (const file of walked.files) {
        if (matches.length >= maxResults) {
          break
        }

        if (!matchesGlob(include, file.path)) {
          continue
        }

        const source = await guard
          .readFileBounded(file.path, DEFAULT_GREP_FILE_BYTES, signal)
          .catch(() => undefined)

        if (!source) {
          continue
        }

        const fileMatches = await searcher.search({
          pattern,
          caseSensitive,
          content: source.content,
          maxResults: maxResults - matches.length,
          signal,
        })

        for (const match of fileMatches) {
          matches.push({ path: file.path, line: match.line, text: match.text })
        }
      }
    } finally {
      await searcher.close()
    }

    return {
      matches,
      truncated: walked.truncated || matches.length >= maxResults,
    }
  }
}

let cachedSearcher: Searcher | undefined
let cacheProbe: Promise<Searcher> | undefined

/**
 * Resolve the workspace searcher. Ripgrep is preferred and the result is
 * cached for the process lifetime; if the binary cannot be spawned once the
 * implementation falls back to the in-process engine and remembers that too,
 * so a broken ripgrep binary does not add a probe to every grep call.
 */
export function resolveWorkspaceSearcher(): Promise<Searcher> {
  if (cachedSearcher) {
    return Promise.resolve(cachedSearcher)
  }

  if (!cacheProbe) {
    cacheProbe = (async () => {
      const ripgrep = new RipgrepSearcher()
      const available = await ripgrep.isAvailable()

      cachedSearcher = available ? ripgrep : new JavaScriptSearcher()
      cacheProbe = undefined
      return cachedSearcher
    })()
  }

  return cacheProbe
}

/**
 * Test helper: reset the cached searcher so callers can force a backend
 * (e.g. JavaScript fallback) without monkey-patching ripgrep availability.
 */
export function __resetCachedSearcher(): void {
  cachedSearcher = undefined
  cacheProbe = undefined
}
