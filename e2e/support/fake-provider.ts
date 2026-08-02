import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export type JsonObject = Record<string, unknown>

export interface CapturedProviderRequest {
  authorization: string
  body: JsonObject
  url: string
}

export interface ProviderMessage {
  role?: string
  content?: string
  toolCallId?: string
}

export interface TraceObject {
  type?: string
  kind?: string
  promptId?: string
  promptHash?: string
  promptResources?: Array<{ id?: string; path?: string; sha256?: string }>
}

export interface FakeProvider {
  origin: string
  requests: CapturedProviderRequest[]
  readonly modelCatalogRequests: number
  queue(chunks: JsonObject[]): void
  armSecondResponseGate(): void
  armResponseGate(requestNumbers: number[]): void
  releaseSecondResponse(): void
  releaseResponseGate(): void
  close(): Promise<void>
}

export const providerApiKey = 'e2e-provider-key'
export const providerModel = 'e2e-functional-model'

async function parseJsonBody(request: IncomingMessage): Promise<JsonObject> {
  let body = ''

  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
  }

  return body ? (JSON.parse(body) as JsonObject) : {}
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const queuedResponses: JsonObject[][] = []
  const requests: CapturedProviderRequest[] = []
  let modelCatalogRequests = 0
  // Optional gate that holds selected provider requests open until a test
  // releases them, allowing deterministic inspection of concurrent runs.
  const gatedRequestNumbers = new Set<number>()
  let responseGate: (() => void) | undefined
  let responseGatePromise: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/models') {
        modelCatalogRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            data: [{ id: providerModel, owned_by: 'e2e' }],
          }),
        )
        return
      }
      if (request.method !== 'POST' || request.url !== '/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'not found' }))
        return
      }

      requests.push({
        authorization: request.headers.authorization ?? '',
        body: await parseJsonBody(request),
        url: request.url,
      })

      const chunks = queuedResponses.shift()
      if (!chunks) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unexpected provider call' }))
        return
      }

      if (gatedRequestNumbers.has(requests.length) && responseGatePromise) {
        await responseGatePromise
      }

      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      })
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'unknown error',
        }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected fake provider to bind to a TCP port')
  }

  return {
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
    get modelCatalogRequests() {
      return modelCatalogRequests
    },
    queue(chunks) {
      queuedResponses.push(chunks)
    },
    armSecondResponseGate() {
      gatedRequestNumbers.clear()
      gatedRequestNumbers.add(2)
      responseGatePromise = new Promise<void>((resolve) => {
        responseGate = resolve
      })
    },
    armResponseGate(requestNumbers) {
      gatedRequestNumbers.clear()
      for (const requestNumber of requestNumbers) {
        gatedRequestNumbers.add(requestNumber)
      }
      responseGatePromise = new Promise<void>((resolve) => {
        responseGate = resolve
      })
    },
    releaseSecondResponse() {
      responseGate?.()
    },
    releaseResponseGate() {
      responseGate?.()
    },
    close() {
      responseGate?.()
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

export function textDelta(text: string, usage?: JsonObject): JsonObject {
  return {
    choices: [{ delta: { content: text } }],
    ...(usage ? { usage } : {}),
  }
}

export function reasoningDelta(reasoning: string): JsonObject {
  return {
    choices: [{ delta: { reasoning_content: reasoning } }],
  }
}

export function toolCallDelta(input: {
  id: string
  name: string
  args: JsonObject
}): JsonObject {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: input.id,
              function: {
                name: input.name,
                arguments: JSON.stringify(input.args),
              },
            },
          ],
        },
      },
    ],
  }
}

export function toolCallsDelta(
  calls: Array<{ id: string; name: string; args: JsonObject }>,
): JsonObject {
  return {
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          })),
        },
      },
    ],
  }
}

export function providerToolNames(body: JsonObject): string[] {
  const tools = body.tools
  if (!Array.isArray(tools)) return []

  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return []
    const fn = (tool as JsonObject).function
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return []
    const name = (fn as JsonObject).name
    return typeof name === 'string' ? [name] : []
  })
}

export function providerMessageText(body: JsonObject): string {
  return providerMessages(body)
    .map((message) => message.content ?? '')
    .join('\n')
}

export function providerMessages(body: JsonObject): ProviderMessage[] {
  const messages = body.messages
  if (!Array.isArray(messages)) return []

  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return []
    }

    const content = (message as JsonObject).content
    const role = (message as JsonObject).role
    const toolCallId = (message as JsonObject).tool_call_id
    return [
      {
        role: typeof role === 'string' ? role : undefined,
        content: typeof content === 'string' ? content : undefined,
        toolCallId: typeof toolCallId === 'string' ? toolCallId : undefined,
      },
    ]
  })
}
