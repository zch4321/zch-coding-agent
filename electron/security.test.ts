import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ENTRY_URL,
  createContentSecurityPolicy,
  getDevServerUrl,
  isAllowedApplicationUrl,
  resolveAppResource,
} from './security'

describe('application URL policy', () => {
  it('only allows the packaged application origin in production', () => {
    expect(isAllowedApplicationUrl(APP_ENTRY_URL)).toBe(true)
    expect(isAllowedApplicationUrl('app://bundle/assets/index.js')).toBe(true)
    expect(isAllowedApplicationUrl('app://other/index.html')).toBe(false)
    expect(isAllowedApplicationUrl('https://example.com')).toBe(false)
    expect(isAllowedApplicationUrl('javascript:alert(1)')).toBe(false)
  })

  it('only allows the exact development origin', () => {
    const devServerUrl = getDevServerUrl('http://127.0.0.1:5173/')

    expect(
      isAllowedApplicationUrl(
        'http://127.0.0.1:5173/src/main.ts',
        devServerUrl,
      ),
    ).toBe(true)
    expect(
      isAllowedApplicationUrl(
        'http://localhost:5173/src/main.ts',
        devServerUrl,
      ),
    ).toBe(false)
    expect(
      isAllowedApplicationUrl('https://127.0.0.1:5173/', devServerUrl),
    ).toBe(false)
  })

  it('rejects unsafe development server URLs', () => {
    expect(() => getDevServerUrl('file:///tmp/index.html')).toThrow()
    expect(() =>
      getDevServerUrl('http://user:password@localhost:5173'),
    ).toThrow()
  })
})

describe('app protocol resource resolution', () => {
  const rendererRoot = path.resolve('dist')

  it('maps application resources inside the renderer directory', () => {
    expect(resolveAppResource(rendererRoot, 'app://bundle/')).toBe(
      path.join(rendererRoot, 'index.html'),
    )
    expect(resolveAppResource(rendererRoot, 'app://bundle/assets/app.js')).toBe(
      path.join(rendererRoot, 'assets', 'app.js'),
    )
  })

  it('rejects other hosts and encoded traversal', () => {
    expect(
      resolveAppResource(rendererRoot, 'app://other/index.html'),
    ).toBeUndefined()
    expect(
      resolveAppResource(rendererRoot, 'app://bundle/%2e%2e%2fsecret.txt'),
    ).toBeUndefined()
  })
})

describe('content security policy', () => {
  it('blocks inline scripts and dangerous embedding capabilities', () => {
    const policy = createContentSecurityPolicy()

    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
  })

  it('only expands style and connection sources for the development origin', () => {
    const policy = createContentSecurityPolicy(
      new URL('http://127.0.0.1:5173/'),
    )

    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain(
      "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
    )
  })
})
