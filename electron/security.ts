import path from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`

export function getDevServerUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined
  }

  const url = new URL(value)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VITE_DEV_SERVER_URL must use http: or https:')
  }

  if (url.username || url.password) {
    throw new Error('VITE_DEV_SERVER_URL must not contain credentials')
  }

  return url
}

export function isAllowedApplicationUrl(
  candidate: string,
  devServerUrl?: URL,
): boolean {
  try {
    const url = new URL(candidate)

    if (devServerUrl) {
      return url.origin === devServerUrl.origin
    }

    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST
  } catch {
    return false
  }
}

export function resolveAppResource(
  rendererRoot: string,
  requestUrl: string,
): string | undefined {
  const url = new URL(requestUrl)

  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
    return undefined
  }

  let pathname: string

  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }

  const relativeRequest =
    pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resourcePath = path.resolve(rendererRoot, relativeRequest)
  const relativePath = path.relative(rendererRoot, resourcePath)

  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return undefined
  }

  return resourcePath
}

export function createContentSecurityPolicy(devServerUrl?: URL): string {
  const connectSources = new Set(["'self'"])

  if (devServerUrl) {
    connectSources.add(devServerUrl.origin)
    connectSources.add(
      `${devServerUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${devServerUrl.host}`,
    )
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    // Naive UI and a few renderer layout bindings rely on runtime style tags
    // and element style attributes. Keep inline script/eval blocked, but allow
    // inline styles so packaged builds don't render unstyled native controls.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...connectSources].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "frame-src 'self'",
  ].join('; ')
}
