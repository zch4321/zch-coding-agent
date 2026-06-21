import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpTransport } from './http-transport'

describe('HttpTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('uses direct fetch when proxy mode is off', async () => {
    const calls: Array<RequestInit | undefined> = []
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init)
        return new Response('ok')
      },
    )
    vi.stubGlobal('fetch', fetchImpl)

    await createHttpTransport({ mode: 'off' }).fetch('https://example.test')

    expect(calls[0]).not.toHaveProperty('dispatcher')
  })

  it('attaches a proxy dispatcher for manual and environment proxy modes', async () => {
    const calls: Array<RequestInit | undefined> = []
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init)
        return new Response('ok')
      },
    )
    vi.stubGlobal('fetch', fetchImpl)

    await createHttpTransport({
      mode: 'manual',
      url: 'http://127.0.0.1:8080',
    }).fetch('https://example.test')
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8081')
    await createHttpTransport({ mode: 'system' }).fetch('https://example.test')

    expect(calls[0]).toHaveProperty('dispatcher')
    expect(calls[1]).toHaveProperty('dispatcher')
  })
})
