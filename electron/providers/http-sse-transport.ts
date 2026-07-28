import type { JsonObject, JsonValue } from '../../shared/json'

export const MAX_SSE_EVENT_BYTES = 4 * 1_024 * 1_024

export type ProviderTransportErrorCode =
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'INVALID_SSE'
  | 'NETWORK_ERROR'
  | 'TIMED_OUT'

/** Reports HTTP or SSE transport failures with a stable code and optional status. */
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
  headers?: Readonly<Record<string, string>>
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
      .map((line) => line.slice(5).replace(/^ /u, ''))
    const payload = lines.join('\n')
    if (payload.trim()) payloads.push(payload)
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

/** Posts JSON to a provider SSE endpoint and exposes bounded parsed response objects. */
export class HttpSseTransport {
  readonly #providerId: string
  readonly #endpoint: string
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: HttpSseTransportOptions) {
    this.#providerId = options.providerId
    this.#endpoint = options.endpoint
    this.#headers = Object.freeze({
      ...(options.headers ?? {
        authorization: `Bearer ${options.apiKey}`,
      }),
      'content-type': 'application/json',
    })
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? 0
    if (
      !Number.isFinite(this.#timeoutMs) ||
      this.#timeoutMs < 0 ||
      (this.#timeoutMs > 0 && this.#timeoutMs < 100)
    ) {
      throw new RangeError(
        'Provider request timeout must be 0 or at least 100ms',
      )
    }
  }

  /** Sends an authenticated JSON request, enforces timeout/abort, and parses SSE data objects. */
  async *postJson(
    request: JsonValue,
    signal: AbortSignal,
  ): AsyncIterable<JsonObject> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort(new Error('Provider request timed out'))
          }, this.#timeoutMs)
        : undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new ProviderTransportError(
          'HTTP_ERROR',
          `${this.#providerId} request failed with status ${response.status}`,
          response.status,
        )
      }

      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = ssePayloads(buffer)
        buffer = parsed.rest
        assertSseSize(buffer)
        for (const payload of parsed.payloads) {
          assertSseSize(payload)
          if (payload.trim() === '[DONE]') return
          yield parsePayload(payload)
        }
      }
      buffer += decoder.decode()
      const trailing = buffer.trim()
      if (trailing) {
        const parsed = ssePayloads(`${buffer}\n\n`)
        for (const payload of parsed.payloads) {
          assertSseSize(payload)
          if (payload.trim() === '[DONE]') return
          yield parsePayload(payload)
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
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => undefined)
    }
  }
}

function assertSseSize(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_SSE_EVENT_BYTES) {
    throw new ProviderTransportError(
      'INVALID_SSE',
      `Provider SSE event exceeds ${MAX_SSE_EVENT_BYTES} bytes`,
    )
  }
}
