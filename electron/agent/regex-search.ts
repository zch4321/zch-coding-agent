import { Worker } from 'node:worker_threads'

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')

parentPort.on('message', ({ id, pattern, flags, content, maxResults }) => {
  try {
    const regexp = new RegExp(pattern, flags)
    const matches = []
    const lines = content.split(/\r?\n/u)

    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      regexp.lastIndex = 0
      if (regexp.test(lines[index])) {
        matches.push({ line: index + 1, text: lines[index].slice(0, 1_000) })
      }
    }

    parentPort.postMessage({ id, ok: true, matches })
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : 'Regular expression failed',
    })
  }
})
`

export class RegexSearchError extends Error {
  constructor(
    readonly code: 'INVALID_REGEX' | 'REGEX_TIMEOUT' | 'REGEX_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'RegexSearchError'
  }
}

export interface RegexLineMatch {
  line: number
  text: string
}

interface WorkerResponse {
  id: number
  ok: boolean
  matches?: RegexLineMatch[]
  message?: string
}

export class BoundedRegexSearcher {
  readonly #worker = new Worker(WORKER_SOURCE, { eval: true })
  #nextId = 1
  #closed = false

  async search(input: {
    pattern: string
    caseSensitive: boolean
    content: string
    maxResults: number
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<RegexLineMatch[]> {
    if (this.#closed) {
      throw new RegexSearchError('REGEX_FAILED', 'Regex worker is closed')
    }

    if (input.signal.aborted) {
      throw input.signal.reason
    }

    const id = this.#nextId++

    return new Promise<RegexLineMatch[]>((resolve, reject) => {
      const finish = (error?: unknown, matches?: RegexLineMatch[]) => {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', abort)
        this.#worker.removeListener('message', message)
        this.#worker.removeListener('error', workerError)

        if (error) {
          reject(error)
        } else {
          resolve(matches ?? [])
        }
      }
      const abort = () => {
        void this.close()
        finish(input.signal.reason ?? new Error('Regex search was cancelled'))
      }
      const message = (response: WorkerResponse) => {
        if (response.id !== id) {
          return
        }

        if (!response.ok) {
          finish(
            new RegexSearchError(
              'INVALID_REGEX',
              response.message ?? 'Regular expression is invalid',
            ),
          )
          return
        }

        finish(undefined, response.matches)
      }
      const workerError = (error: Error) => {
        finish(new RegexSearchError('REGEX_FAILED', error.message))
      }
      const timer = setTimeout(() => {
        void this.close()
        finish(
          new RegexSearchError(
            'REGEX_TIMEOUT',
            'Regular expression exceeded its execution time limit',
          ),
        )
      }, input.timeoutMs ?? 250)

      input.signal.addEventListener('abort', abort, { once: true })
      this.#worker.on('message', message)
      this.#worker.once('error', workerError)
      this.#worker.postMessage({
        id,
        pattern: input.pattern,
        flags: input.caseSensitive ? 'u' : 'iu',
        content: input.content,
        maxResults: input.maxResults,
      })
    })
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }

    this.#closed = true
    await this.#worker.terminate()
  }
}
