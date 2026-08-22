import path from 'node:path'
import type { SerializedOperationalError } from './events'

export interface OperationalSanitizerOptions {
  workspace?: string
  userData?: string
  installation?: string
}

/** Removes credentials and local path roots from bounded operational strings. */
export class OperationalSanitizer {
  readonly #roots: Array<{ value: string; placeholder: string }>

  constructor(options: OperationalSanitizerOptions = {}) {
    this.#roots = [
      [options.workspace, '<workspace>'],
      [options.userData, '<userData>'],
      [options.installation, '<installation>'],
    ]
      .filter((entry): entry is [string, string] => Boolean(entry[0]))
      .flatMap(([value, placeholder]) => {
        const resolved = path.resolve(value)
        const slashed = resolved.replaceAll('\\', '/')
        return [
          { value: resolved, placeholder },
          ...(slashed === resolved ? [] : [{ value: slashed, placeholder }]),
        ]
      })
      .sort((left, right) => right.value.length - left.value.length)
  }

  /** Sanitizes and bounds a single line of diagnostic text. */
  text(value: unknown, maxLength = 2_048): string {
    let result = String(value ?? '').split(/\r?\n/u, 1)[0] ?? ''
    result = result
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, '<redacted>')
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '<redacted>')
      .replace(
        /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
        '$1=<redacted>',
      )
    for (const root of this.#roots) {
      result = replaceAllInsensitive(result, root.value, root.placeholder)
    }
    result = redactUrlSecrets(result)
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/gu, '<path>')
      .replace(/(^|[\s("'=])\/(?:[^/\s"'<>:]+\/)*[^/\s"'<>:]+/gu, '$1<path>')
    return result.slice(0, maxLength)
  }

  /** Reduces an Error and at most two causes to safe diagnostic metadata. */
  error(error: unknown, causeDepth = 0): SerializedOperationalError {
    const source = error instanceof Error ? error : new Error(String(error))
    const code = readErrorCode(source)
    const serialized: SerializedOperationalError = {
      name: this.text(source.name || 'Error', 128),
      message: this.text(source.message || 'Operation failed'),
    }
    if (code) serialized.code = this.text(code, 128)
    const frames = source.stack
      ?.split(/\r?\n/u)
      .slice(1, 17)
      .map((frame) => this.text(frame.trim(), 512))
      .filter(Boolean)
    if (frames?.length) serialized.stack = frames
    if (causeDepth < 2 && source.cause !== undefined) {
      serialized.cause = this.error(source.cause, causeDepth + 1)
    }
    return serialized
  }

  /** Removes URL credentials, query parameters, and fragments. */
  endpoint(value: string | URL | undefined): string | undefined {
    if (!value) return undefined
    try {
      const url = new URL(value.toString())
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return this.text(url.toString(), 2_048)
    } catch {
      return undefined
    }
  }
}

function replaceAllInsensitive(
  value: string,
  search: string,
  replacement: string,
): string {
  if (!search) return value
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return value.replace(new RegExp(escaped, 'giu'), replacement)
}

function redactUrlSecrets(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/giu, (candidate) => {
    try {
      const url = new URL(candidate)
      if (url.username || url.password || url.search || url.hash) {
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
      }
      return url.toString()
    } catch {
      return candidate
    }
  })
}

function readErrorCode(error: Error): string | undefined {
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' && code ? code : undefined
}
