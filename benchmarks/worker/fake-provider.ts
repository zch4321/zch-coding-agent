import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

const DEFAULT_PORT = 8081

export async function runFakeProvider(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const credential = await readSecret(environment.UPSTREAM_API_KEY_FILE)
  const mode = environment.FAKE_PROVIDER_MODE ?? 'patch'
  let requestCount = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, 200, { status: 'ready' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      json(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${credential}`) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    await consume(request)
    requestCount += 1
    if (mode === 'hang') return
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    })
    const payload =
      firstToolCall(mode, requestCount) ?? textDelta('Docker worker completed.')
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(parsePort(environment.PORT), '0.0.0.0', () => {
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

function firstToolCall(mode: string, requestCount: number) {
  if (requestCount !== 1) return undefined
  if (mode === 'patch') {
    return toolCall('docker-smoke-tool', 'apply_patch', {
      path: 'note.txt',
      patch: '@@ -1 +1 @@\n-before\n+after',
    })
  }
  if (mode === 'slug') {
    return toolCall('docker-benchmark-tool', 'apply_patch', {
      path: 'src/slugify.mjs',
      patch:
        "@@ -1,3 +1,8 @@\n export function slugify(value) {\n-  return value.trim().toLowerCase().replace(/\\s+/, '-')\n+  return value\n+    .trim()\n+    .toLowerCase()\n+    .normalize('NFKD')\n+    .replace(/[\\u0300-\\u036f]/g, '')\n+    .replace(/[^a-z0-9]+/g, '-')\n+    .replace(/^-+|-+$/g, '')\n }",
    })
  }
  return undefined
}

function toolCall(id: string, name: string, args: Record<string, string>) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  }
}

function textDelta(content: string) {
  return {
    choices: [{ delta: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }
}

async function consume(request: IncomingMessage): Promise<void> {
  let bytes = 0
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 4 * 1024 * 1024) throw new Error('request too large')
  }
}

async function readSecret(filePath: string | undefined): Promise<string> {
  if (!filePath) throw new Error('UPSTREAM_API_KEY_FILE is required')
  const value = (await readFile(filePath, 'utf8')).trim()
  if (!value) throw new Error('Upstream API key is empty')
  return value
}

function parsePort(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_PORT)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT is invalid')
  }
  return value
}

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runFakeProvider().catch((error) => {
    process.stderr.write(
      `[fake-provider] ${error instanceof Error ? error.message : 'startup failed'}\n`,
    )
    process.exitCode = 1
  })
}
