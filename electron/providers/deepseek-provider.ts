import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_TOOL_INTENT_LENGTH,
} from '../../shared/durable'
import type { CallId } from '../../shared/ids'
import {
  CANONICAL_JSON_LIMITS,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import type { ToolCall } from '../tools/types'
import type { ProviderProfile } from '../../shared/config'
import { resolveChatCompletionsEndpoint } from '../../shared/model-route'
import type {
  LLMProvider,
  ProviderEvent,
  ProviderStreamRequest,
} from './provider'
import { HttpSseTransport } from './http-sse-transport'

export interface OpenAICompatibleProviderOptions {
  providerId: string
  profile: ProviderProfile
  baseURL: string
  endpoint?: string
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
  timeoutMs?: number
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
  argumentsBytes: number
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
  const reason =
    typeof args[intentField] === 'string'
      ? args[intentField].slice(0, MAX_TOOL_INTENT_LENGTH)
      : ''
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

function choiceFinishReason(chunk: JsonObject): string | undefined {
  const choices = chunk.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return undefined
  }
  return typeof first.finish_reason === 'string'
    ? first.finish_reason
    : undefined
}

function usageFromChunk(chunk: JsonObject): JsonValue | undefined {
  const usage = chunk.usage
  return usage && typeof usage === 'object' ? toJsonValue(usage) : undefined
}

function appendBoundedText(
  current: string,
  delta: string,
  label: string,
): string {
  if (current.length + delta.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new RangeError(
      `${label} exceeds maximum length ${MAX_MESSAGE_TEXT_LENGTH}`,
    )
  }
  return current + delta
}

/** Encapsulates open ai compatible provider behavior. */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly #providerId: string
  readonly #profile: ProviderProfile
  readonly #transport: HttpSseTransport
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#providerId = options.providerId
    this.#profile = options.profile
    this.#transport = new HttpSseTransport({
      providerId: options.providerId,
      endpoint:
        options.endpoint ?? resolveChatCompletionsEndpoint(options.baseURL),
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId =
      options.createCallId ?? (() => `call:${randomUUID()}` as CallId)
  }

  /** Returns or updates stream state. */
  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    const providerRequest = structuredClone(request.providerRequest)
    const requestBody = JSON.stringify(providerRequest)
    const requestStart = this.#now()
    let firstTokenAt: number | undefined
    let latestUsage: JsonValue = null
    let rawResponse: JsonValue = null
    let text = ''
    let reasoning = ''
    let finishReason: string | undefined
    const toolCalls = new Map<number, AccumulatedToolCall>()
    const toolIntentFields = intentFields(request.toolDefinitions)

    await request.onRequest?.({
      normalizedMessages: structuredClone(request.normalizedMessages),
      providerRequest: toJsonValue(providerRequest),
      requestBytes: Buffer.byteLength(requestBody, 'utf8'),
      prefixHash: hashJson(toJsonValue(request.normalizedMessages)),
    })

    for await (const chunk of this.#transport.postJson(
      toJsonValue(providerRequest),
      request.signal,
    )) {
      rawResponse = chunk as JsonValue
      finishReason = choiceFinishReason(chunk) ?? finishReason
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
        reasoning = appendBoundedText(
          reasoning,
          reasoningDelta,
          'Provider reasoning',
        )
        yield {
          type: 'reasoning.delta',
          delta: reasoningDelta,
          raw: chunk as JsonValue,
        }
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        firstTokenAt ??= this.#now()
        text = appendBoundedText(text, delta.content, 'Provider text')
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
          if (!toolCalls.has(index) && toolCalls.size >= MAX_MESSAGE_PARTS) {
            throw new RangeError(
              `Provider tool calls exceed maximum count ${MAX_MESSAGE_PARTS}`,
            )
          }
          const current = toolCalls.get(index) ?? {
            index,
            argumentsText: '',
            argumentsBytes: 0,
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
            current.argumentsBytes += Buffer.byteLength(fn.arguments, 'utf8')
            if (current.argumentsBytes > CANONICAL_JSON_LIMITS.maxBytes) {
              throw new RangeError(
                `Provider tool arguments exceed maximum size ${CANONICAL_JSON_LIMITS.maxBytes}`,
              )
            }
            current.argumentsText += fn.arguments
          }

          toolCalls.set(index, current)
          yield {
            type: 'tool.delta',
            index,
            id: current.id,
            name: current.name,
            argumentsDelta:
              fn && typeof fn.arguments === 'string' ? fn.arguments : undefined,
            raw: chunk as JsonValue,
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
    const turn = {
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
      turn: toJsonValue(turn),
      toolCalls: normalizedToolCalls,
      usage: latestUsage,
      ...(finishReason ? { finishReason } : {}),
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

/** Encapsulates deep seek provider behavior. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: DeepSeekProviderOptions) {
    super({
      ...options,
      providerId: 'deepseek',
      profile: 'deepseek',
    })
  }
}
