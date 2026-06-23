import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isPublicNetworkAddress } from '../skills/manager'

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

interface ResolvedAddress {
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

async function resolvePublicAddresses(
  hostname: string,
): Promise<ResolvedAddress[]> {
  let records: { address: string; family: number }[]

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

  if (records.length === 0) {
    throw new SsrfFetchError('DNS_FAILED', `No addresses for ${hostname}`)
  }

  for (const record of records) {
    if (!isPublicNetworkAddress(record.address)) {
      throw new SsrfFetchError(
        'PRIVATE_ADDRESS',
        `Hostname ${hostname} resolves to a private address`,
      )
    }
  }

  return records
}

function performRequest(
  url: URL,
  pinned: ResolvedAddress,
  options: SsrfFetchOptions,
  accept: string,
): Promise<{
  status: number
  location: string | undefined
  contentType: string
  body: Buffer
  truncated: boolean
}> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(
      url,
      {
        method: 'GET',
        signal: options.signal,
        headers: { accept },
        // Pin the connection to the resolved IP so a later DNS rebinding
        // cannot redirect traffic to a private address mid-request.
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        let truncated = false

        response.on('data', (chunk: Buffer) => {
          total += chunk.length

          if (total > options.maxBytes) {
            truncated = true
            request.destroy()
            return
          }

          chunks.push(chunk)
        })

        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: response.headers['content-type'] ?? '',
            body: Buffer.concat(chunks),
            truncated,
          }),
        )

        response.on('error', reject)
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
): Promise<SsrfFetchResponse> {
  const allowedSchemes = options.allowedSchemes ?? ['https:']
  const accept = 'text/plain,text/html;q=0.9,application/json;q=0.9,*/*;q=0.1'

  if (options.signal.aborted) {
    throw new SsrfFetchError('ABORTED', 'Fetch was cancelled')
  }

  let current = validateUrl(input, allowedSchemes)
  let finalUrl = current.href
  let redirects = 0

  while (true) {
    const addresses = await resolvePublicAddresses(current.hostname)
    const pinned = addresses[0]!

    const result = await performRequest(current, pinned, options, accept)

    if (result.status >= 300 && result.status < 400 && result.location) {
      redirects += 1

      if (redirects > options.maxRedirects) {
        throw new SsrfFetchError(
          'TOO_MANY_REDIRECTS',
          `Exceeded ${options.maxRedirects} redirects`,
        )
      }

      current = validateUrl(
        new URL(result.location, current.href).href,
        allowedSchemes,
      )
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
