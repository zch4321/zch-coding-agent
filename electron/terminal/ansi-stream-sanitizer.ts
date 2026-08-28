type ParserState =
  | 'text'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'control-string'
  | 'control-string-escape'

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e
}

function isControlStringIntroducer(value: string): boolean {
  return value === 'P' || value === 'X' || value === '^' || value === '_'
}

/** Removes terminal control sequences while preserving parser state across PTY chunks. */
export class AnsiStreamSanitizer {
  #state: ParserState = 'text'

  /** Consumes one PTY chunk and returns only its visible append-only text. */
  push(chunk: string): string {
    let output = ''
    for (const value of chunk) {
      const code = value.codePointAt(0)!
      if (this.#state === 'text') {
        if (value === '\u001b') {
          this.#state = 'escape'
        } else if (value === '\u009b') {
          this.#state = 'csi'
        } else if (value === '\u009d') {
          this.#state = 'osc'
        } else if (
          value === '\u0090' ||
          value === '\u0098' ||
          value === '\u009e' ||
          value === '\u009f'
        ) {
          this.#state = 'control-string'
        } else if (code < 0x80 || code > 0x9f) {
          output += value
        }
        continue
      }

      if (this.#state === 'escape') {
        if (value === '[') this.#state = 'csi'
        else if (value === ']') this.#state = 'osc'
        else if (isControlStringIntroducer(value)) {
          this.#state = 'control-string'
        } else if (isEscapeIntermediate(code)) {
          this.#state = 'escape-intermediate'
        } else {
          this.#state = 'text'
        }
        continue
      }

      if (this.#state === 'escape-intermediate') {
        if (isEscapeFinal(code)) this.#state = 'text'
        continue
      }

      if (this.#state === 'csi') {
        if (isCsiFinal(code)) this.#state = 'text'
        continue
      }

      if (this.#state === 'osc') {
        if (value === '\u0007' || value === '\u009c') this.#state = 'text'
        else if (value === '\u001b') this.#state = 'osc-escape'
        continue
      }

      if (this.#state === 'osc-escape') {
        if (value === '\\' || value === '\u009c') this.#state = 'text'
        else if (value !== '\u001b') this.#state = 'osc'
        continue
      }

      if (this.#state === 'control-string') {
        if (value === '\u009c') this.#state = 'text'
        else if (value === '\u001b') this.#state = 'control-string-escape'
        continue
      }

      if (value === '\\' || value === '\u009c') this.#state = 'text'
      else if (value !== '\u001b') this.#state = 'control-string'
    }
    return output
  }

  /** Discards any unterminated control sequence at end-of-stream. */
  flush(): string {
    this.#state = 'text'
    return ''
  }
}
