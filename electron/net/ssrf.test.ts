import { describe, expect, it } from 'vitest'
import { fetchWithSsrfGuard, SsrfFetchError } from './ssrf'

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
