import { createHash, randomUUID } from 'node:crypto'
import type { CallId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { ToolCall } from '../tools/types'
import type { ProviderProfile, ReasoningEffort } from '../../shared/config'
import type {
  LLMProvider,
  ProviderAssistantTurn,
  ProviderChatRequest,
  ProviderEvent,
} from './provider'

export interface OpenAICompatibleProviderOptions {
  providerId: string
  profile: ProviderProfile
  baseURL: string
  model: string
  apiKey: string
  reasoning?: ReasoningEffort
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
}

export type DeepSeekProviderOptions = Omit<
  OpenAICompatibleProviderOptions,
  'providerId' | 'profile'
>

interface AccumulatedToolCall {
  index: number
  id?: string
  name?: string
  argumentsText: string
}

function endpoint(baseURL: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL('chat/completions', normalized).toString()
}

function byteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function hashJson(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function parseToolArgs(argumentsText: string): JsonValue {
  if (!argumentsText.trim()) {
    return {}
  }

  try {
    return JSON.parse(argumentsText) as JsonValue
  } catch {
    return { _rawArguments: argumentsText }
  }
}

function intentFields(tools: JsonValue[]): Map<string, string> {
  const fields = new Map<string, string>()

  for (const candidate of tools) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      continue
    }

    const fn = candidate.function

    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      continue
    }

    if (
      typeof fn.name === 'string' &&
      typeof fn['x-agent-intent-property'] === 'string'
    ) {
      fields.set(fn.name, fn['x-agent-intent-property'])
    }
  }

  return fields
}

function wireTools(tools: JsonValue[]): JsonValue[] {
  return tools.map((candidate) => {
    const cloned = structuredClone(candidate)

    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
      return cloned
    }

    const fn = cloned.function

    if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
      delete fn['x-agent-intent-property']
    }

    return cloned
  })
}

function normalizeToolArgs(
  toolId: string,
  argumentsText: string,
  fields: ReadonlyMap<string, string>,
): { args: JsonValue; reason: string } {
  const parsed = parseToolArgs(argumentsText)
  const intentField = fields.get(toolId)

  if (
    !intentField ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { args: parsed, reason: '' }
  }

  const args = structuredClone(parsed)
  const reason = typeof args[intentField] === 'string' ? args[intentField] : ''
  delete args[intentField]
  return { args, reason }
}

function choiceDelta(chunk: JsonObject): JsonObject | undefined {
  const choices = chunk.choices

  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined
  }

  const first = choices[0]

  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return undefined
  }

  const delta = first.delta

  return delta && typeof delta === 'object' && !Array.isArray(delta)
    ? (delta as JsonObject)
    : undefined
}

function usageFromChunk(chunk: JsonObject): JsonValue | undefined {
  const usage = chunk.usage
  return usage && typeof usage === 'object' ? toJsonValue(usage) : undefined
}

function ssePayloads(buffer: string): { payloads: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const chunks = normalized.split('\n\n')
  const rest = chunks.pop() ?? ''
  const payloads: string[] = []

  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())

    if (lines.length > 0) {
      payloads.push(lines.join('\n'))
    }
  }

  return { payloads, rest }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly #providerId: string
  readonly #profile: ProviderProfile
  readonly #baseURL: string
  readonly #model: string
  readonly #apiKey: string
  readonly #reasoning: ReasoningEffort
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#providerId = options.providerId
    this.#profile = options.profile
    this.#baseURL = options.baseURL
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#reasoning = options.reasoning ?? 'off'
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId =
      options.createCallId ?? (() => `call:${randomUUID()}` as CallId)
  }

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    const override = request.providerRequestOverride
    const providerTools = wireTools(request.tools)
    const thinking =
      this.#profile === 'deepseek'
        ? {
            thinking: {
              type: this.#reasoning === 'off' ? 'disabled' : 'enabled',
            },
            ...(this.#reasoning === 'off'
              ? {}
              : { reasoning_effort: this.#reasoning }),
          }
        : {}
    const providerRequest =
      override && typeof override === 'object' && !Array.isArray(override)
        ? structuredClone(override)
        : {
            model: this.#model,
            messages: request.messages,
            tools: providerTools.length > 0 ? providerTools : undefined,
            stream: true,
            stream_options: {
              include_usage: true,
            },
            ...thinking,
          }
    const requestBody = JSON.stringify(providerRequest)
    const requestStart = this.#now()
    let firstTokenAt: number | undefined
    let latestUsage: JsonValue = null
    let rawResponse: JsonValue = null
    let text = ''
    let reasoning = ''
    const toolCalls = new Map<number, AccumulatedToolCall>()
    const toolIntentFields = intentFields(request.tools)

    await request.onRequest?.({
      normalizedMessages: toJsonValue(request.messages) as JsonValue[],
      providerRequest: toJsonValue(providerRequest),
      requestBytes: Buffer.byteLength(requestBody, 'utf8'),
      prefixHash: hashJson(toJsonValue(request.messages)),
    })

    const response = await this.#fetch(endpoint(this.#baseURL), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: requestBody,
      signal: request.signal,
    })

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `${this.#providerId} request failed with status ${response.status}`,
      )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parsed = ssePayloads(buffer)
      buffer = parsed.rest

      for (const payload of parsed.payloads) {
        if (payload === '[DONE]') {
          continue
        }

        const chunk = JSON.parse(payload) as JsonObject
        rawResponse = chunk as JsonValue
        const usage = usageFromChunk(chunk)

        if (usage !== undefined) {
          latestUsage = usage
          yield {
            type: 'usage',
            usage,
            raw: chunk as JsonValue,
          }
        }

        const delta = choiceDelta(chunk)

        if (!delta) {
          continue
        }

        const reasoningDelta = delta.reasoning_content

        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          firstTokenAt ??= this.#now()
          reasoning += reasoningDelta
          yield {
            type: 'reasoning.delta',
            delta: reasoningDelta,
            raw: chunk as JsonValue,
          }
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          firstTokenAt ??= this.#now()
          text += delta.content
          yield {
            type: 'text.delta',
            delta: delta.content,
            raw: chunk as JsonValue,
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const rawToolCall of delta.tool_calls) {
            if (
              !rawToolCall ||
              typeof rawToolCall !== 'object' ||
              Array.isArray(rawToolCall)
            ) {
              continue
            }

            const toolDelta = rawToolCall as JsonObject
            const index =
              typeof toolDelta.index === 'number' ? toolDelta.index : 0
            const current = toolCalls.get(index) ?? {
              index,
              argumentsText: '',
            }
            const fn =
              toolDelta.function &&
              typeof toolDelta.function === 'object' &&
              !Array.isArray(toolDelta.function)
                ? (toolDelta.function as JsonObject)
                : undefined

            if (typeof toolDelta.id === 'string') {
              current.id = toolDelta.id
            }

            if (fn && typeof fn.name === 'string') {
              current.name = fn.name
            }

            if (fn && typeof fn.arguments === 'string') {
              current.argumentsText += fn.arguments
            }

            toolCalls.set(index, current)
            yield {
              type: 'tool.delta',
              index,
              id: current.id,
              name: current.name,
              argumentsDelta:
                fn && typeof fn.arguments === 'string'
                  ? fn.arguments
                  : undefined,
              raw: chunk as JsonValue,
            }
          }
        }
      }
    }

    const nativeToolCalls = [...toolCalls.values()]
      .sort((left, right) => left.index - right.index)
      .filter((toolCall) => toolCall.name)
      .map((toolCall) => ({
        id: toolCall.id ?? this.#createCallId(),
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsText,
        },
      }))
    const normalizedToolCalls: ToolCall[] = nativeToolCalls.map((toolCall) => {
      const toolId = toolCall.function.name ?? ''
      const normalized = normalizeToolArgs(
        toolId,
        toolCall.function.arguments ?? '',
        toolIntentFields,
      )
      return {
        id: toolCall.id as CallId,
        toolId,
        args: normalized.args,
        reason: normalized.reason,
      }
    })
    const turn: ProviderAssistantTurn = {
      role: 'assistant',
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(nativeToolCalls.length > 0
        ? { tool_calls: nativeToolCalls as JsonValue[] }
        : {}),
    }
    const completedAt = this.#now()

    yield {
      type: 'completed',
      rawResponse,
      turn,
      toolCalls: normalizedToolCalls,
      usage: latestUsage,
      providerState: toJsonValue({
        provider: this.#providerId,
        profile: this.#profile,
        assistant: turn,
      }),
      timing: {
        ttftMs: firstTokenAt === undefined ? null : firstTokenAt - requestStart,
        totalMs: completedAt - requestStart,
        responseBytes: byteLength(rawResponse),
      },
    }
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: DeepSeekProviderOptions) {
    super({
      ...options,
      providerId: 'deepseek',
      profile: 'deepseek',
    })
  }
}
