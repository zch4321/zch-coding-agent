import type { JsonObject, JsonValue } from '../../shared/json'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type ProviderTransportErrorCode =
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'INVALID_SSE'
  | 'NETWORK_ERROR'
  | 'TIMED_OUT'

export class ProviderTransportError extends Error {
  constructor(
    readonly code: ProviderTransportErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProviderTransportError'
  }
}

export interface HttpSseTransportOptions {
  providerId: string
  endpoint: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function ssePayloads(buffer: string): { payloads: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/gu, '\n')
  const chunks = normalized.split('\n\n')
  const rest = chunks.pop() ?? ''
  const payloads: string[] = []

  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (lines.length > 0) payloads.push(lines.join('\n'))
  }

  return { payloads, rest }
}

function parsePayload(payload: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error) {
    throw new ProviderTransportError(
      'INVALID_SSE',
      'Provider returned invalid SSE JSON',
      undefined,
      { cause: error },
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderTransportError(
      'INVALID_SSE',
      'Provider SSE payload must be a JSON object',
    )
  }
  return value as JsonObject
}

export class HttpSseTransport {
  readonly #providerId: string
  readonly #endpoint: string
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: HttpSseTransportOptions) {
    this.#providerId = options.providerId
    this.#endpoint = options.endpoint
    this.#apiKey = options.apiKey
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async *postJson(
    request: JsonValue,
    signal: AbortSignal,
  ): AsyncIterable<JsonObject> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Provider request timed out'))
    }, this.#timeoutMs)

    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new ProviderTransportError(
          'TIMED_OUT',
          `${this.#providerId} request timed out`,
          undefined,
          { cause: error },
        )
      }
      if (signal.aborted || controller.signal.aborted) {
        throw new ProviderTransportError(
          'ABORTED',
          `${this.#providerId} request was aborted`,
          undefined,
          { cause: error },
        )
      }
      throw new ProviderTransportError(
        'NETWORK_ERROR',
        `${this.#providerId} network request failed`,
        undefined,
        { cause: error },
      )
    }

    if (!response.ok || !response.body) {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      await response.body?.cancel().catch(() => undefined)
      throw new ProviderTransportError(
        'HTTP_ERROR',
        `${this.#providerId} request failed with status ${response.status}`,
        response.status,
      )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = ssePayloads(buffer)
        buffer = parsed.rest
        for (const payload of parsed.payloads) {
          if (payload !== '[DONE]') yield parsePayload(payload)
        }
      }
      buffer += decoder.decode()
      const trailing = buffer.trim()
      if (trailing) {
        const parsed = ssePayloads(`${buffer}\n\n`)
        for (const payload of parsed.payloads) {
          if (payload !== '[DONE]') yield parsePayload(payload)
        }
      }
    } catch (error) {
      if (error instanceof ProviderTransportError) throw error
      if (timedOut) {
        throw new ProviderTransportError(
          'TIMED_OUT',
          `${this.#providerId} request timed out`,
          undefined,
          { cause: error },
        )
      }
      if (signal.aborted || controller.signal.aborted) {
        throw new ProviderTransportError(
          'ABORTED',
          `${this.#providerId} request was aborted`,
          undefined,
          { cause: error },
        )
      }
      throw new ProviderTransportError(
        'NETWORK_ERROR',
        `${this.#providerId} response stream failed`,
        undefined,
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      await reader.cancel().catch(() => undefined)
    }
  }
}
