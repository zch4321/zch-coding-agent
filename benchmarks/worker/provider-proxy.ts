import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const DEFAULT_PORT = 8080

/** Runs provider proxy. */
export async function runProviderProxy(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const workerToken = await readRequiredSecret(
    environment.WORKER_PROXY_TOKEN_FILE,
    'WORKER_PROXY_TOKEN_FILE',
  )
  const upstreamKey = await readRequiredSecret(
    environment.UPSTREAM_API_KEY_FILE,
    'UPSTREAM_API_KEY_FILE',
  )
  const upstreamBaseURL = parseUpstreamURL(environment.UPSTREAM_BASE_URL)
  const port = parsePort(environment.PORT)
  const maxRequests = parseMaxRequests(environment.MAX_PROVIDER_REQUESTS)
  let requestCount = 0
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      workerToken,
      upstreamKey,
      upstreamBaseURL,
      acceptRequest: () => {
        requestCount += 1
        return requestCount <= maxRequests
      },
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const close = (): void => {
    server.close(() => process.exit(0))
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

async function handleRequest(input: {
  request: IncomingMessage
  response: ServerResponse
  workerToken: string
  upstreamKey: string
  upstreamBaseURL: URL
  acceptRequest: () => boolean
}): Promise<void> {
  const { request, response } = input
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, { status: 'ready' })
      return
    }
    if (
      request.method !== 'POST' ||
      !request.url?.endsWith('/chat/completions')
    ) {
      sendJson(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${input.workerToken}`) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    if (!input.acceptRequest()) {
      sendJson(response, 429, { error: 'request limit exceeded' })
      return
    }
    const body = await readBoundedBody(request)
    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    const upstreamURL = new URL('chat/completions', input.upstreamBaseURL)
    const upstream = await fetch(upstreamURL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.upstreamKey}`,
        'content-type': 'application/json',
      },
      body: body.toString('utf8'),
      signal: controller.signal,
    })
    response.writeHead(upstream.status, {
      'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
    })
    if (!upstream.body) {
      response.end()
      return
    }
    const reader = upstream.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!response.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve) => response.once('drain', resolve))
      }
    }
    response.end()
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error instanceof RequestLimitError ? 413 : 502, {
        error:
          error instanceof RequestLimitError ? error.message : 'proxy failure',
      })
    } else {
      response.destroy()
    }
  }
}

/** Reports request limit failures. */
class RequestLimitError extends Error {}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) {
      throw new RequestLimitError('request too large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readRequiredSecret(
  filePath: string | undefined,
  name: string,
): Promise<string> {
  if (!filePath) throw new Error(`${name} is required`)
  const secret = (await readFile(filePath, 'utf8')).trim()
  if (!secret) throw new Error(`${name} is empty`)
  return secret
}

function parseUpstreamURL(raw: string | undefined): URL {
  if (!raw) throw new Error('UPSTREAM_BASE_URL is required')
  const value = new URL(raw)
  if (
    !['http:', 'https:'].includes(value.protocol) ||
    value.username ||
    value.password
  ) {
    throw new Error(
      'UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials',
    )
  }
  value.pathname = value.pathname.endsWith('/')
    ? value.pathname
    : `${value.pathname}/`
  return value
}

function parsePort(raw: string | undefined): number {
  const value = raw ? Number(raw) : DEFAULT_PORT
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT is invalid')
  }
  return value
}

function parseMaxRequests(raw: string | undefined): number {
  const value = Number(raw ?? 256)
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('MAX_PROVIDER_REQUESTS is invalid')
  }
  return value
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  })
  response.end(JSON.stringify(body))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runProviderProxy().catch((error) => {
    process.stderr.write(
      `[provider-proxy] ${error instanceof Error ? error.message : 'startup failed'}\n`,
    )
    process.exitCode = 1
  })
}
