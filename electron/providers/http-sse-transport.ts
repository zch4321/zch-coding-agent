import type { JsonObject, JsonValue } from '../../shared/json'

export const MAX_SSE_EVENT_BYTES = 4 * 1_024 * 1_024

export type ProviderTransportErrorCode =
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'INVALID_SSE'
  | 'INVALID_JSON'
  | 'NETWORK_ERROR'
  | 'TIMED_OUT'

export interface ProviderTransportErrorOptions extends ErrorOptions {
  retryAfterMs?: number
  providerErrorCode?: string
}

/** Reports bounded HTTP or SSE transport failures and retry metadata. */
export class ProviderTransportError extends Error {
  readonly retryAfterMs: number | undefined
  readonly providerErrorCode: string | undefined

  constructor(
    readonly code: ProviderTransportErrorCode,
    message: string,
    readonly status?: number,
    options?: ProviderTransportErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProviderTransportError'
    this.retryAfterMs = options?.retryAfterMs
    this.providerErrorCode = options?.providerErrorCode
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
        const metadata = await httpErrorMetadata(response)
        throw new ProviderTransportError(
          'HTTP_ERROR',
          `${this.#providerId} request failed with status ${response.status}`,
          response.status,
          metadata,
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

  /** Sends an authenticated JSON request and parses one bounded JSON object response. */
  async postJsonObject(
    request: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonObject> {
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
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        const metadata = await httpErrorMetadata(response)
        throw new ProviderTransportError(
          'HTTP_ERROR',
          `${this.#providerId} request failed with status ${response.status}`,
          response.status,
          metadata,
        )
      }
      const text = await readBoundedJsonBody(response)
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch (error) {
        throw new ProviderTransportError(
          'INVALID_JSON',
          'Provider returned invalid JSON',
          undefined,
          { cause: error },
        )
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProviderTransportError(
          'INVALID_JSON',
          'Provider JSON response must be an object',
        )
      }
      return value as JsonObject
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
        `${this.#providerId} JSON request failed`,
        undefined,
        { cause: error },
      )
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}

function assertSseSize(value: string): void {
  assertProviderPayloadSize(value, 'INVALID_SSE')
}

function assertProviderPayloadSize(
  value: string,
  code: 'INVALID_SSE' | 'INVALID_JSON',
): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_SSE_EVENT_BYTES) {
    throw new ProviderTransportError(
      code,
      `Provider response exceeds ${MAX_SSE_EVENT_BYTES} bytes`,
    )
  }
}

async function readBoundedJsonBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_SSE_EVENT_BYTES) {
        throw new ProviderTransportError(
          'INVALID_JSON',
          `Provider response exceeds ${MAX_SSE_EVENT_BYTES} bytes`,
        )
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  const seconds = Number(normalized)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000)
  }
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

function providerErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const error =
    record.error &&
    typeof record.error === 'object' &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : record
  const code =
    typeof error.code === 'string'
      ? error.code
      : typeof error.type === 'string'
        ? error.type
        : undefined
  return code?.trim().slice(0, 128) || undefined
}

async function httpErrorMetadata(
  response: Response,
): Promise<ProviderTransportErrorOptions> {
  const retryAfterMs = retryAfterMilliseconds(
    response.headers.get('retry-after'),
  )
  let parsed: unknown
  try {
    const text = await readBoundedJsonBody(response)
    if (text.trim()) parsed = JSON.parse(text)
  } catch {
    await response.body?.cancel().catch(() => undefined)
  }
  const code = providerErrorCode(parsed)
  return {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(code ? { providerErrorCode: code } : {}),
  }
}
