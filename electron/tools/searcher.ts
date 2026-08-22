import { stat } from 'node:fs/promises'
import { BoundedRegexSearcher } from './regex-search'
import { RipgrepSearcher } from './ripgrep-searcher'
import {
  type SearchInput,
  type SearchMatch,
  type SearchOutcome,
  type Searcher,
} from './searcher-types'
import { iterateWorkspaceGlobFiles } from './workspace-glob'
import { PathGuardError } from '../safety/path-guard'

const DEFAULT_GREP_FILE_BYTES = 256_000

export type { SearchInput, SearchMatch, SearchOutcome, Searcher }

async function* iterateSearchFiles(
  input: Pick<SearchInput, 'guard' | 'rootInput' | 'include' | 'signal'>,
): AsyncGenerator<string> {
  const root = await input.guard.resolveExisting(input.rootInput)
  const rootStats = await stat(root.realPath)
  if (rootStats.isFile()) {
    yield root.relativePath
    return
  }
  if (!rootStats.isDirectory()) {
    throw new PathGuardError(
      'NOT_A_DIRECTORY',
      'Grep path must be a file or directory',
    )
  }

  yield* iterateWorkspaceGlobFiles({
    guard: input.guard,
    rootInput: root.relativePath,
    pattern: input.include,
    signal: input.signal,
    baseNameMatch: true,
  })
}

/**
 * In-process fallback that enumerates the include glob and runs a bounded
 * worker-thread regex over each matching file's content.
 */
export class JavaScriptSearcher implements Searcher {
  readonly backend = 'javascript' as const

  /** Searches guarded workspace files with include and result limits. */
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
    const matches: SearchMatch[] = []
    const searcher = new BoundedRegexSearcher()
    let truncated = false

    try {
      for await (const file of iterateSearchFiles({
        guard,
        rootInput,
        include,
        signal,
      })) {
        const source = await guard
          .readFileBounded(file, DEFAULT_GREP_FILE_BYTES, signal)
          .catch(() => undefined)

        if (!source) {
          continue
        }
        truncated ||= source.truncated

        const fileMatches = await searcher.search({
          pattern,
          caseSensitive,
          content: source.content,
          maxResults: maxResults + 1 - matches.length,
          signal,
        })

        for (const match of fileMatches) {
          matches.push({ path: file, line: match.line, text: match.text })
        }

        if (matches.length > maxResults) {
          truncated = true
          break
        }
      }
    } finally {
      await searcher.close()
    }

    return {
      matches: matches.slice(0, maxResults),
      truncated,
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
