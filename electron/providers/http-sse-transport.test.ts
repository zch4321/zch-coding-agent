import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HttpSseTransport,
  MAX_SSE_EVENT_BYTES,
  ProviderTransportError,
} from './http-sse-transport'

function streamResponse(
  chunks: readonly string[],
  options: { status?: number; close?: boolean } = {},
): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        if (options.close !== false) controller.close()
      },
    }),
    { status: options.status ?? 200 },
  )
}

function transport(
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): HttpSseTransport {
  return new HttpSseTransport({
    providerId: 'test-provider',
    endpoint: 'https://provider.test/chat/completions',
    apiKey: 'secret',
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

async function collect(
  target: HttpSseTransport,
  signal = new AbortController().signal,
) {
  const values = []
  for await (const value of target.postJson({ model: 'test' }, signal)) {
    values.push(value)
  }
  return values
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('HttpSseTransport', () => {
  it('reassembles split CRLF and multiline data while ignoring empty events and DONE', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        ': keep-alive\r',
        '\n\r\ndata:\r\n\r\ndata: {"first":\r\n',
        'data: 1}\r\n\r\ndata: {"second":2}\r\n\r\ndata: [DONE]   \r\n\r\ndata: {"ignored":true}\r\n\r\n',
      ]),
    ) as unknown as typeof fetch

    await expect(collect(transport(fetchImpl))).resolves.toEqual([
      { first: 1 },
      { second: 2 },
    ])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.test/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      }),
    )
  })

  it('parses a final event without a blank-line terminator', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse(['data: {"tail":true}']),
    ) as unknown as typeof fetch

    await expect(collect(transport(fetchImpl))).resolves.toEqual([
      { tail: true },
    ])
  })

  it('has no default total wall-clock timer', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () =>
      streamResponse(['data: {"ok":true}\n\n']),
    ) as unknown as typeof fetch

    await expect(collect(transport(fetchImpl))).resolves.toEqual([{ ok: true }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports an explicit request timeout and cleans it up', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    ) as unknown as typeof fetch
    const pending = collect(transport(fetchImpl, 100))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'TIMED_OUT',
    })

    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps caller abort and fetch failures and always removes listeners', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const abortingFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    ) as unknown as typeof fetch
    const pending = collect(transport(abortingFetch), controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(remove).toHaveBeenCalled()

    const failedController = new AbortController()
    const failedRemove = vi.spyOn(
      failedController.signal,
      'removeEventListener',
    )
    const failingFetch = vi.fn(async () => {
      throw new Error('dns')
    }) as unknown as typeof fetch
    await expect(
      collect(transport(failingFetch), failedController.signal),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(failedRemove).toHaveBeenCalled()
  })

  it('rejects HTTP errors, invalid JSON and oversized events', async () => {
    const httpFetch = vi.fn(async () =>
      streamResponse(['denied'], { status: 503 }),
    ) as unknown as typeof fetch
    await expect(collect(transport(httpFetch))).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 503,
    })

    const invalidFetch = vi.fn(async () =>
      streamResponse(['data: not-json\n\n']),
    ) as unknown as typeof fetch
    await expect(collect(transport(invalidFetch))).rejects.toMatchObject({
      code: 'INVALID_SSE',
    })

    const oversizedFetch = vi.fn(async () =>
      streamResponse([`data: "${'x'.repeat(MAX_SSE_EVENT_BYTES + 1)}`]),
    ) as unknown as typeof fetch
    await expect(collect(transport(oversizedFetch))).rejects.toEqual(
      expect.objectContaining<Partial<ProviderTransportError>>({
        code: 'INVALID_SSE',
      }),
    )
  })
})
