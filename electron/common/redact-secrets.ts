import type { JsonValue } from '../../shared/json'

interface SecretMatcher {
  value: string
  fallback: number[]
  matched: number
}

function matcher(value: string): SecretMatcher {
  const fallback = Array<number>(value.length).fill(0)
  for (let index = 1, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched])
      matched = fallback[matched - 1]!
    if (value[index] === value[matched]) matched += 1
    fallback[index] = matched
  }
  return { value, fallback, matched: 0 }
}

/** Redacts literal secrets across chunks, retaining only undecided secret prefixes. */
export class StreamingSecretRedactor {
  readonly #matchers: SecretMatcher[]
  #pending = ''
  #masked = new Uint8Array(0)
  #redacting = false

  constructor(secrets: readonly string[]) {
    this.#matchers = [...new Set(secrets.filter(Boolean))].map(matcher)
  }

  /** Returns safe text while withholding any suffix that may complete a secret. */
  append(value: string): string {
    if (this.#matchers.length === 0) return value
    const previousLength = this.#pending.length
    this.#pending += value
    const masked = new Uint8Array(this.#pending.length)
    masked.set(this.#masked)
    let retained = 0
    for (const state of this.#matchers) {
      for (let index = 0; index < value.length; index += 1) {
        while (state.matched > 0 && value[index] !== state.value[state.matched])
          state.matched = state.fallback[state.matched - 1]!
        if (value[index] === state.value[state.matched]) state.matched += 1
        if (state.matched === state.value.length) {
          const end = previousLength + index + 1
          masked.fill(1, end - state.value.length, end)
          state.matched = state.fallback[state.matched - 1]!
        }
      }
      retained = Math.max(retained, state.matched)
    }
    this.#masked = masked
    return this.#drain(this.#pending.length - retained)
  }

  /** Flushes an ended stream's unmatched suffix and resets matching state for reuse. */
  finish(): string {
    for (const state of this.#matchers) state.matched = 0
    const result = this.#drain(this.#pending.length)
    this.#redacting = false
    return result
  }

  #drain(length: number): string {
    const output: string[] = []
    let plainStart = 0
    for (let index = 0; index < length; index += 1) {
      if (this.#masked[index]) {
        if (plainStart < index)
          output.push(this.#pending.slice(plainStart, index))
        if (!this.#redacting) output.push('[redacted]')
        this.#redacting = true
        plainStart = index + 1
      } else {
        this.#redacting = false
      }
    }
    if (plainStart < length)
      output.push(this.#pending.slice(plainStart, length))
    this.#pending = this.#pending.slice(length)
    this.#masked = this.#masked.slice(length)
    return output.join('')
  }
}

/** Replaces complete literal secrets, including overlapping and short values. */
export function redactTextSecrets(
  value: string,
  secrets: readonly string[],
): string {
  const redactor = new StreamingSecretRedactor(secrets)
  return redactor.append(value) + redactor.finish()
}

/** Redacts string values in JSON using the same literal matching policy as streams. */
export function redactJsonSecrets(
  value: JsonValue,
  secrets: readonly string[],
): JsonValue {
  const redactor = new StreamingSecretRedactor(secrets)
  const visit = (nested: JsonValue): JsonValue => {
    if (typeof nested === 'string')
      return redactor.append(nested) + redactor.finish()
    if (Array.isArray(nested)) return nested.map(visit)
    if (nested && typeof nested === 'object')
      return Object.fromEntries(
        Object.entries(nested).map(([key, item]) => [key, visit(item)]),
      )
    return nested
  }
  return visit(value)
}
