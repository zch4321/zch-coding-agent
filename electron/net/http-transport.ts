import { ProxyAgent, type Dispatcher } from 'undici'
import type { HttpProxyConfig } from '../../shared/config'

type FetchInit = RequestInit & { dispatcher?: Dispatcher }
export type FetchImplementation = typeof fetch

export interface HttpTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export function createHttpTransport(
  proxy: HttpProxyConfig = { mode: 'off' },
): HttpTransport {
  const proxyUrl =
    proxy.mode === 'manual'
      ? proxy.url
      : proxy.mode === 'system'
        ? systemProxyUrl()
        : undefined
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

  return {
    fetch(input, init) {
      return fetch(input, {
        ...init,
        ...(dispatcher ? { dispatcher } : {}),
      } as FetchInit)
    },
  }
}

function systemProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  )
}
