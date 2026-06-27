import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isPublicNetworkAddress } from './network-address'

export interface SsrfFetchOptions {
  /** Hard cap on the response body in bytes. */
  maxBytes: number
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Maximum redirect hops before failing. */
  maxRedirects: number
  /** Allowed URL schemes. Defaults to https only. */
  allowedSchemes?: readonly string[]
  signal: AbortSignal
  /** Optional allow-list of lowercased MIME prefixes; empty means any. */
  allowedMimePrefixes?: readonly string[]
  /** Extra request headers merged over the defaults. */
  headers?: Record<string, string>
}

/**
 * Internal hooks for deterministic tests. These are NOT part of the public
 * options surface — production callers have no way to set them through
 * `fetchWithSsrfGuard`'s typed signature. They exist so the SSRF guard can be
 * exercised against a local HTTP server (whose loopback address would
 * otherwise be rejected) without weakening the real DNS/private-address path.
 */
export interface SsrfTestHooks {
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>
  isAddressPublic?: (address: string) => boolean
}

export interface SsrfFetchResponse {
  url: string
  status: number
  contentType: string
  body: string
  truncated: boolean
  totalBytes: number
}

export class SsrfFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SsrfFetchError'
  }
}

export interface ResolvedAddress {
  address: string
  family: number
}

function validateUrl(input: string, allowedSchemes: readonly string[]): URL {
  let url: URL

  try {
    url = new URL(input)
  } catch {
    throw new SsrfFetchError('INVALID_URL', 'URL is invalid')
  }

  if (!allowedSchemes.includes(url.protocol)) {
    throw new SsrfFetchError(
      'INVALID_URL',
      `URL scheme ${url.protocol} is not allowed`,
    )
  }

  if (url.username || url.password) {
    throw new SsrfFetchError('INVALID_URL', 'URL must not contain credentials')
  }

  return url
}

const SENSITIVE_HEADER_PREFIXES = [
  'authorization',
  'cookie',
  'x-subscription-token',
  'x-api-key',
  'proxy-authorization',
]

export function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
  )
}

export function stripSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_PREFIXES.includes(name.toLowerCase())) {
      next[name] = value
    }
  }

  return next
}

async function resolvePublicAddresses(
  hostname: string,
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>,
  isAddressPublic: (address: string) => boolean = isPublicNetworkAddress,
): Promise<ResolvedAddress[]> {
  let records: { address: string; family: number }[]

  if (resolveHost) {
    records = await resolveHost(hostname)
  } else {
    try {
      records = (await dnsLookup(hostname, { all: true, verbatim: true })).map(
        (record) => ({
          address: record.address,
          family: record.family === 6 ? 6 : 4,
        }),
      )
    } catch {
      throw new SsrfFetchError('DNS_FAILED', `Failed to resolve ${hostname}`)
    }
  }

  if (records.length === 0) {
    throw new SsrfFetchError('DNS_FAILED', `No addresses for ${hostname}`)
  }

  for (const record of records) {
    if (!isAddressPublic(record.address)) {
      throw new SsrfFetchError(
        'PRIVATE_ADDRESS',
        `Hostname ${hostname} resolves to a private address`,
      )
    }
  }

  return records
}

/**
 * Build the connection target for IP pinning. For IPv6 the address must be
 * written as a bracketed host (`[addr]:port`); assigning a bare IPv6 literal
 * to `url.hostname` is a silent no-op in Node, which would leave the request
 * resolving the original domain and defeat DNS-rebinding protection. The Host
 * header preserves the original hostname so virtual-host routing still works.
 *
 * Pure and exported so pinning correctness can be unit-tested for IPv4/IPv6
 * without standing up a real server.
 */
export function buildPinnedRequest(
  url: URL,
  pinned: ResolvedAddress,
): {
  pinnedUrl: URL
  hostHeader: string
  servername?: string
} {
  const pinnedUrl = new URL(url.href)
  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  const port = url.port || defaultPort

  if (pinned.family === 6) {
    pinnedUrl.host = `[${pinned.address}]:${port}`
  } else {
    pinnedUrl.hostname = pinned.address
    pinnedUrl.port = port
  }

  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname

  // For HTTPS the socket dials the IP, but TLS SNI / certificate validation
  // must still use the original hostname.
  return {
    pinnedUrl,
    hostHeader,
    servername: url.protocol === 'https:' ? url.hostname : undefined,
  }
}

function performRequest(
  url: URL,
  pinned: ResolvedAddress,
  options: SsrfFetchOptions,
  accept: string,
  headers?: Record<string, string>,
): Promise<{
  status: number
  location: string | undefined
  contentType: string
  body: Buffer
  truncated: boolean
}> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    // Pin the connection to the resolved IP by rewriting the request URL's
    // hostname while preserving the original Host header. buildPinnedRequest
    // handles the IPv6 bracketed-host case that a bare hostname assignment
    // would silently drop.
    const { pinnedUrl, hostHeader, servername } = buildPinnedRequest(
      url,
      pinned,
    )
    const request = transport(
      pinnedUrl,
      {
        method: 'GET',
        signal: options.signal,
        headers: { accept, host: hostHeader, ...headers },
        ...(servername ? { servername } : {}),
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        let truncated = false
        let settled = false

        const finishWithBody = () => {
          if (settled) {
            return
          }
          settled = true
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks),
            truncated,
          })
        }

        response.on('data', (chunk: Buffer) => {
          if (truncated) {
            return
          }

          total += chunk.length

          if (total > options.maxBytes) {
            // Keep the part of this chunk that still fits under the cap so the
            // bounded body is exactly maxBytes, not the previously-read bytes.
            const overshoot = total - options.maxBytes
            const usable = chunk.subarray(0, chunk.length - overshoot)
            if (usable.length > 0) {
              chunks.push(usable)
            }
            truncated = true
            // Destroy the socket so the server stops streaming, then resolve
            // with the bounded body already read instead of surfacing an
            // ECONNRESET error.
            request.destroy()
            finishWithBody()
            return
          }

          chunks.push(chunk)
        })

        response.on('end', finishWithBody)

        response.on('error', (error) => {
          if (truncated || settled) {
            return
          }
          reject(
            error instanceof SsrfFetchError
              ? error
              : new SsrfFetchError('REQUEST_FAILED', error.message),
          )
        })
      },
    )

    const timer = setTimeout(() => {
      request.destroy(
        new SsrfFetchError(
          'TIMEOUT',
          `Request timed out after ${options.timeoutMs} ms`,
        ),
      )
    }, options.timeoutMs)
    timer.unref()

    request.on('error', (error) => {
      clearTimeout(timer)
      reject(
        error instanceof SsrfFetchError
          ? error
          : new SsrfFetchError('REQUEST_FAILED', error.message),
      )
    })
    request.on('close', () => clearTimeout(timer))

    if (options.signal.aborted) {
      request.destroy(new SsrfFetchError('ABORTED', 'Fetch was cancelled'))
    }

    request.end()
  })
}

/**
 * Fetch a URL with SSRF defences: scheme allow-list, no credentials, every
 * redirect hop is re-resolved and rejected when it points at a private
 * address, the connection is pinned to the resolved IP, and the body is
 * bounded in bytes and time. Network content is treated as untrusted.
 */
export async function fetchWithSsrfGuard(
  input: string,
  options: SsrfFetchOptions,
  hooks?: SsrfTestHooks,
): Promise<SsrfFetchResponse> {
  const allowedSchemes = options.allowedSchemes ?? ['https:']
  const accept = 'text/plain,text/html;q=0.9,application/json;q=0.9,*/*;q=0.1'

  if (options.signal.aborted) {
    throw new SsrfFetchError('ABORTED', 'Fetch was cancelled')
  }

  let current = validateUrl(input, allowedSchemes)
  let finalUrl = current.href
  let redirects = 0
  let requestHeaders = options.headers

  while (true) {
    const addresses = await resolvePublicAddresses(
      current.hostname,
      hooks?.resolveHost,
      hooks?.isAddressPublic,
    )
    const pinned = addresses[0]!

    const result = await performRequest(
      current,
      pinned,
      options,
      accept,
      requestHeaders,
    )

    if (result.status >= 300 && result.status < 400 && result.location) {
      redirects += 1

      if (redirects > options.maxRedirects) {
        throw new SsrfFetchError(
          'TOO_MANY_REDIRECTS',
          `Exceeded ${options.maxRedirects} redirects`,
        )
      }

      const next = validateUrl(
        new URL(result.location, current.href).href,
        allowedSchemes,
      )

      // Strip sensitive headers when a redirect crosses origin so an
      // attacker-controlled redirect target never receives credentials
      // intended for the original host.
      if (requestHeaders && !sameOrigin(current, next)) {
        requestHeaders = stripSensitiveHeaders(requestHeaders)
      }

      current = next
      finalUrl = current.href
      continue
    }

    if (options.allowedMimePrefixes && options.allowedMimePrefixes.length > 0) {
      const mime = result.contentType.toLowerCase().split(';')[0]!.trim()
      if (
        !options.allowedMimePrefixes.some((prefix) => mime.startsWith(prefix))
      ) {
        throw new SsrfFetchError(
          'UNSUPPORTED_MIME',
          `Content type ${result.contentType} is not allowed`,
        )
      }
    }

    return {
      url: finalUrl,
      status: result.status,
      contentType: result.contentType,
      body: result.body.toString('utf8'),
      truncated: result.truncated,
      totalBytes: result.body.length,
    }
  }
}
