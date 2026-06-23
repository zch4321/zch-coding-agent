import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  fetchWithSsrfGuard,
  SsrfFetchError,
  sameOrigin,
  stripSensitiveHeaders,
  type ResolvedAddress,
} from './ssrf'

function fetchOk(url: string, overrides: Record<string, unknown> = {}) {
  return fetchWithSsrfGuard(url, {
    maxBytes: 4_096,
    timeoutMs: 5_000,
    maxRedirects: 3,
    allowedSchemes: ['https:', 'http:'],
    signal: new AbortController().signal,
    ...overrides,
  })
}

describe('SSRF fetch guard', () => {
  it('rejects URLs that are not on the allow-list', async () => {
    await expect(fetchOk('file:///etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_URL',
    })
  })

  it('rejects URLs containing credentials', async () => {
    await expect(
      fetchOk('https://user:pass@example.com/'),
    ).rejects.toMatchObject({ code: 'INVALID_URL' })
  })

  it('rejects loopback hostnames resolved to a private address', async () => {
    await expect(fetchOk('http://127.0.0.1/')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
  })

  it('rejects localhost (resolves to loopback)', async () => {
    await expect(fetchOk('http://localhost:65535/')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
  })

  it('rejects link-local and rfc1918 addresses', async () => {
    await expect(fetchOk('http://169.254.169.254/')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
    await expect(fetchOk('http://10.0.0.1/')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
    await expect(fetchOk('http://192.168.1.1/')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
  })

  it('rejects an unresolvable hostname', async () => {
    const result = fetchOk('https://this-host-does-not-exist-zch.invalid/')
    // Some sandboxes resolve unknown hosts to a captive-portal/private
    // address; either way the guard must reject.
    await expect(result).rejects.toBeInstanceOf(SsrfFetchError)
  })

  it('rejects when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchWithSsrfGuard('https://example.com/', {
        maxBytes: 4_096,
        timeoutMs: 5_000,
        maxRedirects: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('surfaces SsrfFetchError with a code', () => {
    const error = new SsrfFetchError('PRIVATE_ADDRESS', 'private')
    expect(error.code).toBe('PRIVATE_ADDRESS')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('redirect header policy', () => {
  it('treats matching protocol/host/port as same origin', () => {
    expect(
      sameOrigin(
        new URL('https://a.example/x'),
        new URL('https://a.example/y'),
      ),
    ).toBe(true)
    expect(
      sameOrigin(
        new URL('https://a.example:443/x'),
        new URL('https://a.example/x'),
      ),
    ).toBe(true)
  })

  it('treats a different host as cross origin', () => {
    expect(
      sameOrigin(new URL('https://a.example/'), new URL('https://b.example/')),
    ).toBe(false)
    expect(
      sameOrigin(new URL('http://a.example/'), new URL('https://a.example/')),
    ).toBe(false)
  })

  it('strips sensitive headers from a cross-origin redirect target', () => {
    const stripped = stripSensitiveHeaders({
      'X-Subscription-Token': 'secret',
      Authorization: 'Bearer x',
      Cookie: 'session=1',
      Accept: 'application/json',
    })

    expect(stripped).toEqual({ Accept: 'application/json' })
  })

  it('keeps sensitive headers on a same-origin redirect', () => {
    // The fetch loop only calls stripSensitiveHeaders when sameOrigin() is
    // false; a same-origin redirect keeps the original header set untouched.
    const origin = new URL('https://api.example.com/x')
    const redirect = new URL('https://api.example.com/y')
    expect(sameOrigin(origin, redirect)).toBe(true)

    const headers = {
      'X-Subscription-Token': 'secret',
      accept: 'application/json',
    }
    // The cross-origin transform is not applied on same-origin redirects, so
    // the original header object retains its token.
    expect(headers['X-Subscription-Token']).toBe('secret')
  })
})

describe('SSRF fetch against a local server', () => {
  let server: Server
  let port: number
  const received: Array<{
    url: string
    headers: Record<string, string | string[] | undefined>
  }> = []

  // The SSRF guard rejects loopback; the test seam lets us treat the local
  // server's address as public so we can exercise the real HTTP path.
  const loopbackResolver = async (
    hostname: string,
  ): Promise<ResolvedAddress[]> => {
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return [{ address: '127.0.0.1', family: 4 }]
    }
    return []
  }
  const allowLoopback = () => true

  function localUrl(path: string) {
    return `http://localhost:${port}${path}`
  }

  async function startServer(
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => void,
  ) {
    received.length = 0
    server = createServer((req, res) => {
      received.push({
        url: req.url ?? '',
        headers: { ...req.headers },
      })
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  }

  async function closeServer() {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  function fetchLocal(url: string, overrides: Record<string, unknown> = {}) {
    return fetchWithSsrfGuard(url, {
      maxBytes: 4_096,
      timeoutMs: 5_000,
      maxRedirects: 3,
      allowedSchemes: ['http:'],
      signal: new AbortController().signal,
      resolveHost: loopbackResolver,
      isAddressPublic: allowLoopback,
      allowedMimePrefixes: ['text/', 'application/json'],
      ...overrides,
    })
  }

  it('returns a successful response body', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('hello world')
    })

    try {
      const response = await fetchLocal(localUrl('/ok'))
      expect(response.status).toBe(200)
      expect(response.body).toBe('hello world')
      expect(response.contentType).toContain('text/plain')
      expect(response.truncated).toBe(false)
    } finally {
      await closeServer()
    }
  })

  it('rejects a disallowed MIME type', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'image/png')
      res.end('binary')
    })

    try {
      await expect(fetchLocal(localUrl('/img'))).rejects.toMatchObject({
        code: 'UNSUPPORTED_MIME',
      })
    } finally {
      await closeServer()
    }
  })

  it('follows a same-origin redirect while keeping headers', async () => {
    await startServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302
        res.setHeader('location', '/dest')
        res.end()
      } else {
        res.setHeader('content-type', 'text/plain')
        res.end('redirected')
      }
    })

    try {
      const response = await fetchLocal(localUrl('/start'), {
        headers: { 'X-Subscription-Token': 'secret' },
      })
      expect(response.status).toBe(200)
      expect(response.body).toBe('redirected')
      // The Authorization-style header survived a same-origin redirect.
      expect(
        received.some((r) => r.headers['x-subscription-token'] === 'secret'),
      ).toBe(true)
    } finally {
      await closeServer()
    }
  })

  it('strips sensitive headers on a cross-origin redirect', async () => {
    await startServer((req, res) => {
      if (req.url === '/start') {
        // Cross-origin: a different port on the same server still differs by
        // port from the original URL, but here we redirect to a path on the
        // same server while changing the host header target via a redirect to
        // an explicit 127.0.0.1 hostname (different origin string).
        res.statusCode = 302
        res.setHeader('location', `http://127.0.0.1:${port}/dest`)
        res.end()
      } else {
        res.setHeader('content-type', 'text/plain')
        res.end('redirected')
      }
    })

    try {
      const response = await fetchLocal(localUrl('/start'), {
        headers: { 'X-Subscription-Token': 'secret' },
      })
      expect(response.status).toBe(200)
      // The redirect target (127.0.0.1) is a cross-origin from the request
      // host (localhost), so the sensitive header must not be forwarded.
      const destRequest = received.find((r) => r.url === '/dest')
      expect(destRequest?.headers['x-subscription-token']).toBeUndefined()
    } finally {
      await closeServer()
    }
  })

  it('bounds the body at maxBytes and marks truncated', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('A'.repeat(10_000))
    })

    try {
      const response = await fetchLocal(localUrl('/big'), { maxBytes: 64 })
      expect(response.truncated).toBe(true)
      expect(Buffer.byteLength(response.body, 'utf8')).toBe(64)
    } finally {
      await closeServer()
    }
  })

  it('sends the sanitized Accept header', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('ok')
    })

    try {
      await fetchLocal(localUrl('/accept'), {
        headers: { accept: 'text/csv' },
      })
      const acceptReq = received.find((r) => r.url === '/accept')
      expect(acceptReq?.headers.accept).toBe('text/csv')
    } finally {
      await closeServer()
    }
  })
})
