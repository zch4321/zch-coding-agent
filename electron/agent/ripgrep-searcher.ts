import { spawn } from 'node:child_process'
import { normalizePortablePath } from './glob'
import { RegexSearchError } from './regex-search'
import type {
  SearchInput,
  SearchMatch,
  SearchOutcome,
  Searcher,
} from '../tools/searcher-types'

const SKIPPED_GLOBS = ['!node_modules', '!.git', '!dist']

function normalizeRgPath(raw: string): string {
  return normalizePortablePath(raw).replace(/^\.\//u, '')
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '')
}

interface RgJsonMatch {
  type: 'match'
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
  }
}

function isMatchRecord(value: unknown): value is RgJsonMatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'match'
  )
}

/**
 * Ripgrep-backed workspace searcher. Spawns the bundled `rg` binary with
 * `--json` output so matching paths/lines are structured (no colon splitting
 * heuristics) and runs with `cwd` pinned to the workspace root.
 *
 * The binary path is resolved lazily via the ESM-only `@vscode/ripgrep`
 * package; once it is known to be missing the searcher reports unavailable so
 * the shared resolver can fall back to the in-process engine.
 */
export class RipgrepSearcher implements Searcher {
  readonly backend = 'ripgrep' as const

  #rgPath: string | undefined
  #available: boolean | undefined

  private async resolveRgPath(): Promise<string | undefined> {
    if (this.#rgPath !== undefined) {
      return this.#rgPath
    }

    try {
      const module = (await import('@vscode/ripgrep')) as {
        rgPath: string
      }
      this.#rgPath = module.rgPath
      return this.#rgPath
    } catch {
      this.#rgPath = undefined
      return undefined
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.#available !== undefined) {
      return this.#available
    }

    const rgPath = await this.resolveRgPath()
    if (!rgPath) {
      this.#available = false
      return false
    }

    this.#available = await new Promise<boolean>((resolve) => {
      const child = spawn(rgPath, ['--version'], { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        resolve(false)
      }, 5_000)

      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })

    return this.#available
  }

  async search(input: SearchInput): Promise<SearchOutcome> {
    const rgPath = await this.resolveRgPath()

    if (!rgPath) {
      throw new Error('ripgrep binary is not available')
    }

    const {
      guard,
      rootInput,
      include,
      maxResults,
      signal,
      pattern,
      caseSensitive,
    } = input
    const cwd = guard.workspacePath
    // Re-anchor to the workspace root so rg emits relative paths. resolveExisting
    // already returns a portable relative path ('.' for the workspace root).
    const resolvedRoot = await guard.resolveExisting(rootInput)
    const searchPath = resolvedRoot.relativePath || '.'

    const args = [
      '--json',
      '--no-ignore',
      '--sort',
      'path',
      // rg applies -g globs in order with later globs taking precedence, so
      // include first then the exclusions last to keep node_modules/.git/dist
      // out regardless of the include pattern.
      '-g',
      include,
      ...SKIPPED_GLOBS.flatMap((glob) => ['-g', glob]),
    ]

    if (!caseSensitive) {
      args.push('--ignore-case')
    }

    args.push('--', pattern, searchPath)

    const matches: SearchMatch[] = []
    let walkedTruncated = false

    await new Promise<void>((resolve, reject) => {
      const child = spawn(rgPath, args, { cwd, windowsHide: true })
      let leftover = ''
      let capped = false

      const finish = () => {
        child.kill()
        resolve()
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (capped) {
          return
        }

        leftover += chunk

        let newlineIndex = leftover.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = leftover.slice(0, newlineIndex)
          leftover = leftover.slice(newlineIndex + 1)
          newlineIndex = leftover.indexOf('\n')

          if (!line) {
            continue
          }

          let record: unknown
          try {
            record = JSON.parse(line)
          } catch {
            continue
          }

          if (!isMatchRecord(record)) {
            continue
          }

          matches.push({
            path: normalizeRgPath(record.data.path.text),
            line: record.data.line_number,
            text: stripTrailingNewline(record.data.lines.text).slice(0, 1_000),
          })

          if (matches.length >= maxResults) {
            capped = true
            walkedTruncated = true
            finish()
            return
          }
        }
      })

      child.stderr.setEncoding('utf8')
      let stderrText = ''
      child.stderr.on('data', (chunk: string) => {
        stderrText += chunk
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (capped) {
          resolve()
          return
        }

        // rg exit codes: 0 = matches found, 1 = no matches, 2+ = error
        // (bad regex, IO failure, etc.). Treat 2+ as a structured failure so
        // invalid regex surfaces instead of being swallowed as empty results.
        if (code !== null && code > 1) {
          const detail = stderrText.trim() || `ripgrep exited with code ${code}`
          reject(
            /regex|invalid pattern/iu.test(detail)
              ? new RegexSearchError('INVALID_REGEX', detail)
              : new RegexSearchError('REGEX_FAILED', detail),
          )
          return
        }

        resolve()
      })

      const onAbort = () => {
        child.kill()
        reject(signal.reason ?? new Error('ripgrep search was cancelled'))
      }

      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        child.on('exit', () => signal.removeEventListener('abort', onAbort))
      }
    })

    return {
      matches,
      truncated: walkedTruncated || matches.length >= maxResults,
    }
  }
}
