import { randomUUID } from 'node:crypto'
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
import {
  renderToolResultContent,
  type MessagePart,
  type MessageRecord,
  type ToolCallPart,
} from '../../shared/message'
import { renderLiveUserInterjection } from '../../shared/live-interjection'
import { canonicalHash, messageText } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'
import { ProviderCompletionError, providerCompactText } from './provider'
import type {
  ProviderCompileInput,
  ProviderEvent,
  ProviderTiming,
  ProviderToolDefinition,
  ProviderUsage,
} from './provider'

type ProviderRole = 'system' | 'user' | 'assistant' | 'tool'

interface ProviderMessage {
  role: ProviderRole
  content?: string | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: JsonValue[]
}

interface ProviderAssistantTurn extends ProviderMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: JsonValue[]
}

interface AccumulatedToolCall {
  index: number
  id?: string
  name?: string
  argumentsText: string
  argumentsBytes: number
}

export interface ChatCompletionOptions {
  providerId: string
  providerType:
    | 'deepseek.chat-completions'
    | 'mimo.chat-completions'
    | 'generic.chat-completions'
  now: () => number
  createCallId: () => CallId
}

export interface ChatCompletionAccumulator {
  readonly requestStart: number
  firstTokenAt?: number
  latestUsage: JsonValue
  rawResponse: JsonValue
  text: string
  reasoning: string
  finishReason?: string
  readonly toolCalls: Map<number, AccumulatedToolCall>
  readonly toolIntentFields: Map<string, string>
}

export const CHAT_COMPLETIONS_CONTINUATION_FORMAT =
  'chat-completions.assistant.v1'

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function byteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function nativeToolCalls(parts: readonly ToolCallPart[]): JsonValue[] {
  return parts.map((part) => ({
    id: part.callId,
    type: 'function',
    function: {
      name: part.name,
      arguments: JSON.stringify(part.arguments),
    },
  }))
}

function canonicalAssistant(
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): ProviderAssistantTurn {
  const calls = record.parts.filter(
    (part): part is ToolCallPart => part.type === 'tool_call',
  )
  const content = messageText(record)
  return {
    role: 'assistant',
    content: content || null,
    ...(record.normalizedReasoningText
      ? { reasoning_content: record.normalizedReasoningText }
      : {}),
    ...(calls.length > 0 ? { tool_calls: nativeToolCalls(calls) } : {}),
  }
}

function continuationAssistant(
  providerType: ChatCompletionOptions['providerType'],
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): ProviderAssistantTurn | undefined {
  const continuation = record.providerContinuation
  if (
    !continuation ||
    continuation.providerType !== providerType ||
    continuation.format !== CHAT_COMPLETIONS_CONTINUATION_FORMAT
  ) {
    return undefined
  }
  const data = continuation.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Chat continuation payload is corrupt')
  }
  if (data.partsHash !== canonicalHash(record.parts)) return undefined
  const assistant = data.assistant
  if (
    !assistant ||
    typeof assistant !== 'object' ||
    Array.isArray(assistant) ||
    assistant.role !== 'assistant' ||
    !('content' in assistant)
  ) {
    throw new TypeError('Chat continuation assistant payload is corrupt')
  }
  return structuredClone(assistant) as unknown as ProviderAssistantTurn
}

function compileMessage(
  providerType: ChatCompletionOptions['providerType'],
  route: ProviderCompileInput['route'],
  record: MessageRecord,
): ProviderMessage[] {
  switch (record.kind) {
    case 'system_instruction':
      return [{ role: 'system', content: messageText(record) }]
    case 'assistant_turn':
      return [
        continuationAssistant(providerType, record) ??
          canonicalAssistant(record),
      ]
    case 'tool_result': {
      const result = record.parts[0]
      return [
        {
          role: 'tool',
          tool_call_id: result.callId,
          content: renderToolResultContent(result.content),
        },
      ]
    }
    case 'interjection':
      return [
        {
          role: 'user',
          content: renderLiveUserInterjection(messageText(record)),
        },
      ]
    case 'compact_summary':
      return [{ role: 'user', content: providerCompactText(record, route) }]
    default:
      return [{ role: 'user', content: messageText(record) }]
  }
}

/** Converts neutral tools to Chat Completions function definitions. */
export function compileChatTools(
  tools: readonly ProviderToolDefinition[],
): JsonValue[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.inputSchema),
    },
  }))
}

/** Compiles canonical history into ordered Chat Completions messages. */
export function compileChatMessages(
  history: ProviderCompileInput['history'],
  providerType: ChatCompletionOptions['providerType'],
  route: ProviderCompileInput['route'],
): JsonObject[] {
  return toJsonValue(
    history.messages.flatMap((record) =>
      compileMessage(providerType, route, record),
    ),
  ) as JsonObject[]
}

function parseToolArgs(argumentsText: string): JsonValue {
  if (!argumentsText.trim()) return {}
  try {
    return JSON.parse(argumentsText) as JsonValue
  } catch {
    return { _rawArguments: argumentsText }
  }
}

function intentFields(
  tools: readonly ProviderToolDefinition[],
): Map<string, string> {
  return new Map(tools.map((tool) => [tool.name, tool.intentParameter]))
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
  if (!Array.isArray(choices) || choices.length === 0) return undefined
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

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function objectField(value: unknown, key: string): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const field = Reflect.get(value, key)
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as JsonObject)
    : undefined
}

/** Normalizes Chat Completions token usage while retaining the raw payload. */
export function normalizeChatUsage(value: JsonValue): ProviderUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { raw: value }
  }
  const usage = value as JsonObject
  const promptTokens = metric(usage.prompt_tokens)
  const completionDetails = objectField(usage, 'completion_tokens_details')
  const promptDetails = objectField(usage, 'prompt_tokens_details')
  const cacheHitTokens =
    metric(usage.prompt_cache_hit_tokens) ??
    metric(promptDetails?.cached_tokens)
  const explicitCacheMissTokens = metric(usage.prompt_cache_miss_tokens)
  return {
    promptTokens,
    completionTokens: metric(usage.completion_tokens),
    totalTokens: metric(usage.total_tokens),
    reasoningTokens: metric(completionDetails?.reasoning_tokens),
    cacheHitTokens,
    cacheMissTokens:
      explicitCacheMissTokens ??
      (promptTokens !== undefined
        ? Math.max(0, promptTokens - (cacheHitTokens ?? 0))
        : undefined),
    raw: structuredClone(value),
  }
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

/** Normalizes provider-native Chat Completions finish reasons. */
export function normalizeChatFinishReason(
  providerReason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (providerReason === 'length') return 'truncated'
  if (providerReason === 'content_filter') return 'content_filter'
  if (providerReason === 'tool_calls' || hasToolCalls) return 'tool_calls'
  if (providerReason === 'stop' || providerReason === undefined) {
    return 'completed'
  }
  return providerReason
}

/** Creates mutable state for one concrete Provider's stream parser. */
export function createChatCompletionAccumulator(
  tools: readonly ProviderToolDefinition[],
  requestStart: number,
): ChatCompletionAccumulator {
  return {
    requestStart,
    latestUsage: null,
    rawResponse: null,
    text: '',
    reasoning: '',
    toolCalls: new Map(),
    toolIntentFields: intentFields(tools),
  }
}

/** Applies one SSE payload and returns its bounded canonical delta events. */
export function accumulateChatCompletionChunk(
  state: ChatCompletionAccumulator,
  chunk: JsonObject,
  now: () => number,
): Array<Exclude<ProviderEvent, { type: 'completed' }>> {
  const events: Array<Exclude<ProviderEvent, { type: 'completed' }>> = []
  state.rawResponse = toJsonValue(chunk)
  state.finishReason = choiceFinishReason(chunk) ?? state.finishReason
  const usage = chunk.usage
  if (usage && typeof usage === 'object') {
    state.latestUsage = toJsonValue(usage)
  }

  const delta = choiceDelta(chunk)
  if (!delta) return events

  const reasoningDelta = delta.reasoning_content
  if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
    state.firstTokenAt ??= now()
    state.reasoning = appendBoundedText(
      state.reasoning,
      reasoningDelta,
      'Provider reasoning',
    )
    events.push({
      type: 'reasoning.delta',
      delta: reasoningDelta,
      raw: chunk as JsonValue,
    })
  }

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    state.firstTokenAt ??= now()
    state.text = appendBoundedText(state.text, delta.content, 'Provider text')
    events.push({
      type: 'text.delta',
      delta: delta.content,
      raw: chunk as JsonValue,
    })
  }

  if (!Array.isArray(delta.tool_calls)) return events
  for (const rawToolCall of delta.tool_calls) {
    if (
      !rawToolCall ||
      typeof rawToolCall !== 'object' ||
      Array.isArray(rawToolCall)
    ) {
      continue
    }
    const toolDelta = rawToolCall as JsonObject
    const index = typeof toolDelta.index === 'number' ? toolDelta.index : 0
    if (
      !state.toolCalls.has(index) &&
      state.toolCalls.size >= MAX_MESSAGE_PARTS
    ) {
      throw new RangeError(
        `Provider tool calls exceed maximum count ${MAX_MESSAGE_PARTS}`,
      )
    }
    const current = state.toolCalls.get(index) ?? {
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
    if (typeof toolDelta.id === 'string') current.id = toolDelta.id
    if (fn && typeof fn.name === 'string') current.name = fn.name
    if (fn && typeof fn.arguments === 'string') {
      current.argumentsBytes += Buffer.byteLength(fn.arguments, 'utf8')
      if (current.argumentsBytes > CANONICAL_JSON_LIMITS.maxBytes) {
        throw new RangeError(
          `Provider tool arguments exceed maximum size ${CANONICAL_JSON_LIMITS.maxBytes}`,
        )
      }
      current.argumentsText += fn.arguments
    }
    state.toolCalls.set(index, current)
    state.firstTokenAt ??= now()
    events.push({
      type: 'tool.delta',
      index,
      id: current.id,
      name: current.name,
      argumentsDelta:
        fn && typeof fn.arguments === 'string' ? fn.arguments : undefined,
      raw: chunk as JsonValue,
    })
  }
  return events
}

/** Finalizes accumulated Chat Completions state into one canonical turn. */
export function completeChatCompletion(
  state: ChatCompletionAccumulator,
  options: ChatCompletionOptions,
): Extract<ProviderEvent, { type: 'completed' }> {
  const nativeCalls = [...state.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .filter((toolCall) => toolCall.name)
    .map((toolCall) => ({
      id: toolCall.id ?? options.createCallId(),
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsText,
      },
    }))
  const normalizedToolCalls: ToolCall[] = nativeCalls.map((toolCall) => {
    const toolId = toolCall.function.name ?? ''
    const normalized = normalizeToolArgs(
      toolId,
      toolCall.function.arguments ?? '',
      state.toolIntentFields,
    )
    return {
      id: toolCall.id as CallId,
      toolId,
      args: normalized.args,
      reason: normalized.reason,
    }
  })
  const assistant: ProviderAssistantTurn = {
    role: 'assistant',
    content: state.text || null,
    ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
    ...(nativeCalls.length > 0
      ? { tool_calls: nativeCalls as JsonValue[] }
      : {}),
  }
  const parts: MessagePart[] = []
  if (state.text) parts.push({ type: 'text', text: state.text })
  for (const toolCall of normalizedToolCalls) {
    parts.push({
      type: 'tool_call',
      callId: toolCall.id,
      name: toolCall.toolId,
      arguments: structuredClone(toolCall.args),
    })
  }
  const completedAt = options.now()
  const timing: ProviderTiming = {
    ttftMs:
      state.firstTokenAt === undefined
        ? null
        : state.firstTokenAt - state.requestStart,
    totalMs: completedAt - state.requestStart,
    responseBytes: byteLength(state.rawResponse),
  }
  const usage = normalizeChatUsage(state.latestUsage)
  const providerState = toJsonValue({
    providerId: options.providerId,
    providerType: options.providerType,
    assistant,
  })
  if (parts.length === 0) {
    throw new ProviderCompletionError(
      state.reasoning
        ? 'Provider returned reasoning without an assistant answer; retry the request'
        : 'Provider completed with an empty assistant turn',
      {
        rawResponse: structuredClone(state.rawResponse),
        providerState,
        usage: structuredClone(usage.raw),
        timing,
      },
    )
  }
  return {
    type: 'completed',
    turn: {
      parts,
      toolCalls: normalizedToolCalls,
      ...(state.reasoning ? { normalizedReasoningText: state.reasoning } : {}),
      providerContinuation: {
        schemaVersion: 2,
        providerType: options.providerType,
        format: CHAT_COMPLETIONS_CONTINUATION_FORMAT,
        data: {
          partsHash: canonicalHash(parts),
          assistant: toJsonValue(assistant),
        },
      },
      usage,
      finishReason: normalizeChatFinishReason(
        state.finishReason,
        normalizedToolCalls.length > 0,
      ),
    },
    rawResponse: structuredClone(state.rawResponse),
    providerState,
    timing,
  }
}

/** Creates the default call-ID generator used by Chat Completions providers. */
export function createChatCallId(): CallId {
  return `call:${randomUUID()}` as CallId
}
