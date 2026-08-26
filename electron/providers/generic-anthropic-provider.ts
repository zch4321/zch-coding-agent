import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
} from '../../shared/durable'
import type { CallId } from '../../shared/ids'
import {
  assertBoundedJsonValue,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import {
  renderToolResultContent,
  type MessagePart,
  type MessageRecord,
} from '../../shared/message'
import { renderLiveUserInterjection } from '../../shared/live-interjection'
import { resolveAnthropicMessagesEndpoint } from '../../shared/model-route'
import { canonicalHash, messageText } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'
import {
  normalizedAnthropicCompactUsage,
  normalizedAnthropicUsage,
} from './anthropic-usage'
import { projectAnthropicToolInputSchema } from './anthropic-tool-schema'
import { HttpSseTransport } from './http-sse-transport'
import {
  ProviderCompletionError,
  ProviderCompactUnsupportedError,
  providerCompactPayload,
  providerCompactText,
  syntheticCompactEvents,
  type CompiledProviderCall,
  type CompiledProviderCompactCall,
  type ModelProvider,
  type ProviderCompactEvent,
  type ProviderCompactInput,
  type ProviderCompactMode,
  type ProviderCompileInput,
  type ProviderEvent,
  type ProviderResponseDiagnostics,
  type ProviderStreamContext,
  type ProviderTiming,
  type ProviderToolDefinition,
} from './provider'
import {
  appendProviderArguments,
  appendProviderText,
  createProviderCallId,
  normalizeProviderToolCall,
  providerIntentFields,
  providerJsonBytes,
  providerMetric,
  providerObjectField,
  toProviderJson,
} from './provider-shared'

export const ANTHROPIC_CONTINUATION_FORMAT = 'anthropic.message-content.v1'
export const ANTHROPIC_COMPACT_FORMAT = 'anthropic.compaction-block.v1'
export const ANTHROPIC_API_VERSION = '2023-06-01'
export const ANTHROPIC_COMPACT_BETA = 'compact-2026-01-12'
const ANTHROPIC_COMPACT_MIN_INPUT_TOKENS = 50_000

interface AnthropicAccumulator {
  requestStart: number
  firstTokenAt?: number
  latestRaw: JsonValue
  message: JsonObject
  blocks: Map<number, JsonObject>
  stoppedBlocks: Set<number>
  toolArguments: Map<number, string>
  streamedText: string
  streamedReasoning: string
  startUsage: JsonValue
  deltaUsage: JsonValue
  stopReason?: string
  stopSequence?: string | null
}

export interface GenericAnthropicProviderOptions {
  providerId: string
  baseURL: string
  endpoint?: string
  apiKey: string
  apiVersion?: string
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
  timeoutMs?: number
}

function anthropicTools(tools: readonly ProviderToolDefinition[]): JsonValue[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: projectAnthropicToolInputSchema(tool),
  }))
}

function canonicalAnthropicContent(
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): JsonObject[] {
  const content: JsonObject[] = []
  const text = messageText(record)
  if (text) content.push({ type: 'text', text })
  for (const part of record.parts) {
    if (part.type !== 'tool_call') continue
    content.push({
      type: 'tool_use',
      id: part.callId,
      name: part.name,
      input: structuredClone(part.arguments),
    })
  }
  return content
}

function anthropicContinuationContent(
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): JsonObject[] | undefined {
  const continuation = record.providerContinuation
  if (
    !continuation ||
    continuation.providerType !== 'generic.anthropic' ||
    continuation.format !== ANTHROPIC_CONTINUATION_FORMAT
  ) {
    return undefined
  }
  const data = continuation.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Anthropic continuation payload is corrupt')
  }
  if (data.partsHash !== canonicalHash(record.parts)) return undefined
  if (
    !Array.isArray(data.content) ||
    data.content.some(
      (block) => !block || typeof block !== 'object' || Array.isArray(block),
    )
  ) {
    throw new TypeError('Anthropic continuation content is corrupt')
  }
  return structuredClone(data.content) as JsonObject[]
}

function isAnthropicCompactionBlock(block: JsonValue): block is JsonObject {
  return Boolean(
    block &&
    typeof block === 'object' &&
    !Array.isArray(block) &&
    block.type === 'compaction' &&
    typeof block.content === 'string' &&
    block.content.trim().length > 0,
  )
}

function containsAnthropicCompactionBlock(
  messages: readonly JsonObject[],
): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(isAnthropicCompactionBlock),
  )
}

function anthropicCompactContent(
  record: Extract<MessageRecord, { kind: 'compact_summary' }>,
  route: ProviderCompileInput['route'],
): JsonObject[] | undefined {
  const payload = providerCompactPayload(record, route)
  if (!payload || payload.format === 'summary-text.v1') return undefined
  if (payload.format !== ANTHROPIC_COMPACT_FORMAT) {
    throw new TypeError(
      `Unsupported Anthropic compact format: ${payload.format}`,
    )
  }
  const data = payload.data
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Array.isArray(data.content) ||
    data.content.length === 0 ||
    data.content.some(
      (block) =>
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        typeof block.type !== 'string',
    ) ||
    !data.content.some(isAnthropicCompactionBlock)
  ) {
    throw new TypeError('Anthropic compact content is corrupt')
  }
  return structuredClone(data.content) as JsonObject[]
}

function appendAnthropicMessage(
  messages: JsonObject[],
  role: 'user' | 'assistant',
  blocks: JsonObject[],
): void {
  const previous = messages.at(-1)
  if (
    role === 'user' &&
    previous?.role === 'user' &&
    Array.isArray(previous.content)
  ) {
    previous.content.push(...blocks)
    return
  }
  messages.push({ role, content: blocks })
}

function compileAnthropicHistory(
  history: ProviderCompileInput['history'],
  route: ProviderCompileInput['route'],
): {
  system?: string
  messages: JsonObject[]
} {
  const system = history.messages
    .filter((record) => record.kind === 'system_instruction')
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const messages: JsonObject[] = []
  for (const record of history.messages) {
    switch (record.kind) {
      case 'system_instruction':
        break
      case 'assistant_turn':
        appendAnthropicMessage(
          messages,
          'assistant',
          anthropicContinuationContent(record) ??
            canonicalAnthropicContent(record),
        )
        break
      case 'tool_result': {
        const result = record.parts[0]
        appendAnthropicMessage(messages, 'user', [
          {
            type: 'tool_result',
            tool_use_id: result.callId,
            content: renderToolResultContent(result.content),
            ...(result.isError ? { is_error: true } : {}),
          },
        ])
        break
      }
      case 'interjection':
        appendAnthropicMessage(messages, 'user', [
          {
            type: 'text',
            text: renderLiveUserInterjection(messageText(record)),
          },
        ])
        break
      case 'compact_summary': {
        const nativeContent = anthropicCompactContent(record, route)
        appendAnthropicMessage(
          messages,
          nativeContent ? 'assistant' : 'user',
          nativeContent ?? [
            { type: 'text', text: providerCompactText(record, route) },
          ],
        )
        break
      }
      default:
        appendAnthropicMessage(messages, 'user', [
          { type: 'text', text: messageText(record) },
        ])
    }
  }
  return { ...(system ? { system } : {}), messages }
}

function anthropicOutputConfig(
  input: ProviderCompileInput,
): JsonObject | undefined {
  const outputConfig: JsonObject = {}
  if (input.route.reasoning !== 'off') {
    outputConfig.effort = input.route.reasoning
  }
  if (input.structuredOutput) {
    outputConfig.format = {
      type: 'json_schema',
      schema:
        input.structuredOutput.type === 'json_schema'
          ? structuredClone(input.structuredOutput.schema)
          : { type: 'object' },
    }
  }
  return Object.keys(outputConfig).length > 0 ? outputConfig : undefined
}

function anthropicFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
    return 'truncated'
  }
  if (reason === 'tool_use' || hasToolCalls) return 'tool_calls'
  if (reason === 'end_turn' || reason === undefined) return 'completed'
  return reason
}

function anthropicTiming(
  state: AnthropicAccumulator,
  now: () => number,
  rawResponse: JsonValue,
): ProviderTiming {
  const completedAt = now()
  return {
    ttftMs:
      state.firstTokenAt === undefined
        ? null
        : state.firstTokenAt - state.requestStart,
    totalMs: completedAt - state.requestStart,
    responseBytes: providerJsonBytes(rawResponse),
  }
}

/** Implements the generic Anthropic Messages fallback. */
export class GenericAnthropicProvider implements ModelProvider {
  readonly providerType = 'generic.anthropic' as const
  readonly #providerId: string
  readonly #transport: HttpSseTransport
  readonly #compactTransport: HttpSseTransport
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: GenericAnthropicProviderOptions) {
    this.#providerId = options.providerId
    const endpoint =
      options.endpoint ?? resolveAnthropicMessagesEndpoint(options.baseURL)
    const apiVersion = options.apiVersion ?? ANTHROPIC_API_VERSION
    this.#transport = new HttpSseTransport({
      providerId: options.providerId,
      endpoint,
      apiKey: options.apiKey,
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': apiVersion,
      },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#compactTransport = new HttpSseTransport({
      providerId: options.providerId,
      endpoint,
      apiKey: options.apiKey,
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': apiVersion,
        'anthropic-beta': ANTHROPIC_COMPACT_BETA,
      },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId = options.createCallId ?? createProviderCallId
  }

  /** Compiles canonical history into Anthropic Messages and content blocks. */
  compile(input: ProviderCompileInput): CompiledProviderCall {
    if (input.route.providerType !== this.providerType) {
      throw new TypeError(
        `Route Provider ${input.route.providerType} does not match ${this.providerType}`,
      )
    }
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
      throw new RangeError(
        'Provider max output tokens must be a positive integer',
      )
    }
    const compiled = compileAnthropicHistory(input.history, input.route)
    const tools = structuredClone(input.tools)
    const wireTools = anthropicTools(tools)
    const outputConfig = anthropicOutputConfig(input)
    const request = {
      model: input.route.model,
      ...(compiled.system ? { system: compiled.system } : {}),
      messages: compiled.messages,
      ...(wireTools.length > 0 ? { tools: wireTools } : {}),
      max_tokens: input.maxOutputTokens,
      stream: true,
      ...(input.route.reasoning === 'off'
        ? {}
        : { thinking: { type: 'adaptive' } }),
      ...(outputConfig ? { output_config: outputConfig } : {}),
    } as JsonObject
    return {
      request,
      normalizedMessages: structuredClone(compiled.messages),
      tools,
    }
  }

  /** Exposes native compaction when Anthropic's minimum trigger can be met. */
  compactModes(input: ProviderCompactInput): readonly ProviderCompactMode[] {
    return input.contextTokens !== undefined &&
      input.contextTokens < ANTHROPIC_COMPACT_MIN_INPUT_TOKENS
      ? ['synthetic']
      : ['native', 'synthetic']
  }

  /** Compiles native Anthropic context management or portable summarization. */
  compileCompact(
    input: ProviderCompactInput,
    mode: ProviderCompactMode = 'native',
  ): CompiledProviderCompactCall {
    if (input.route.providerType !== this.providerType) {
      throw new TypeError(
        `Route Provider ${input.route.providerType} does not match ${this.providerType}`,
      )
    }
    const compiled = compileAnthropicHistory(input.history, input.route)
    if (mode === 'synthetic') {
      const messages = structuredClone(compiled.messages)
      appendAnthropicMessage(messages, 'user', [
        { type: 'text', text: input.instructions },
      ])
      const call = this.compile({
        history: input.history,
        route: input.route,
        tools: [],
        maxOutputTokens: input.maxOutputTokens,
      })
      return {
        mode,
        request: {
          ...structuredClone(call.request),
          messages: structuredClone(messages),
        },
        normalizedMessages: structuredClone(messages),
      }
    }
    if (mode !== 'native') {
      throw new TypeError(`Unsupported Anthropic compact mode: ${mode}`)
    }
    return {
      mode,
      request: {
        model: input.route.model,
        ...(compiled.system ? { system: compiled.system } : {}),
        messages: structuredClone(compiled.messages),
        max_tokens: input.maxOutputTokens,
        context_management: {
          edits: [
            {
              type: 'compact_20260112',
              trigger: {
                type: 'input_tokens',
                value: ANTHROPIC_COMPACT_MIN_INPUT_TOKENS,
              },
              pause_after_compaction: true,
              instructions: input.instructions,
            },
          ],
        },
      },
      normalizedMessages: structuredClone(compiled.messages),
    }
  }

  /** Executes native context management or a regular text-summary request. */
  async *compact(
    call: CompiledProviderCompactCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderCompactEvent> {
    if (call.mode === 'synthetic') {
      yield* syntheticCompactEvents(
        this.providerType,
        this.stream(
          {
            request: structuredClone(call.request),
            normalizedMessages: structuredClone(call.normalizedMessages),
            tools: [],
          },
          context,
        ),
      )
      return
    }
    if (call.mode !== 'native') {
      throw new TypeError(`Unsupported Anthropic compact mode: ${call.mode}`)
    }
    const startedAt = this.#now()
    const response = await this.#compactTransport.postJsonObject(
      structuredClone(call.request),
      context.signal,
    )
    const completedAt = this.#now()
    const usage = normalizedAnthropicCompactUsage(
      toProviderJson(response.usage ?? null),
    )
    const compactTiming: ProviderTiming = {
      ttftMs: null,
      totalMs: completedAt - startedAt,
      responseBytes: providerJsonBytes(response),
    }
    const providerState = toProviderJson({
      providerId: this.#providerId,
      providerType: this.providerType,
      message: response,
    })
    const diagnostics: ProviderResponseDiagnostics = {
      rawResponse: structuredClone(response),
      providerState,
      usage: structuredClone(usage.raw),
      timing: compactTiming,
    }
    const content = Array.isArray(response.content)
      ? response.content
      : undefined
    if (
      response.stop_reason !== 'compaction' ||
      !content ||
      content.length === 0 ||
      content.some(
        (block) =>
          !block ||
          typeof block !== 'object' ||
          Array.isArray(block) ||
          typeof block.type !== 'string',
      ) ||
      !content.some(isAnthropicCompactionBlock)
    ) {
      throw new ProviderCompactUnsupportedError(
        'Anthropic compact returned an incompatible compaction block',
        { diagnostics },
      )
    }
    const data = { content: structuredClone(content) }
    assertBoundedJsonValue(data)
    yield {
      type: 'completed',
      compact: {
        payload: {
          schemaVersion: 1,
          providerType: this.providerType,
          format: ANTHROPIC_COMPACT_FORMAT,
          data,
        },
        usage,
      },
      rawResponse: structuredClone(response),
      providerState,
      timing: compactTiming,
    }
  }

  /** Sends one Anthropic Messages request and normalizes content-block SSE. */
  async *stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent> {
    const state: AnthropicAccumulator = {
      requestStart: this.#now(),
      latestRaw: null,
      message: {},
      blocks: new Map(),
      stoppedBlocks: new Set(),
      toolArguments: new Map(),
      streamedText: '',
      streamedReasoning: '',
      startUsage: null,
      deltaUsage: null,
    }
    const transport = containsAnthropicCompactionBlock(call.normalizedMessages)
      ? this.#compactTransport
      : this.#transport
    for await (const event of transport.postJson(
      structuredClone(call.request),
      context.signal,
    )) {
      state.latestRaw = toProviderJson(event)
      const eventType = typeof event.type === 'string' ? event.type : ''
      if (eventType === 'error') {
        throw this.#completionError('Anthropic request failed', state, event)
      }
      if (eventType === 'message_start') {
        const message = providerObjectField(event, 'message')
        if (message) {
          state.message = structuredClone(message)
          state.startUsage = toProviderJson(message.usage ?? null)
        }
        continue
      }
      if (eventType === 'content_block_start') {
        const started = this.#startBlock(state, event)
        if (started) yield started
        continue
      }
      if (eventType === 'content_block_delta') {
        const delta = this.#applyBlockDelta(state, event)
        if (delta) yield delta
        continue
      }
      if (eventType === 'content_block_stop') {
        this.#stopBlock(state, event)
        continue
      }
      if (eventType === 'message_delta') {
        const delta = providerObjectField(event, 'delta')
        if (typeof delta?.stop_reason === 'string') {
          state.stopReason = delta.stop_reason
        }
        if (delta && 'stop_sequence' in delta) {
          state.stopSequence =
            typeof delta.stop_sequence === 'string' ? delta.stop_sequence : null
        }
        if ('usage' in event) state.deltaUsage = toProviderJson(event.usage)
        continue
      }
      if (eventType === 'message_stop') {
        yield this.#complete(call, state, event)
        return
      }
    }
    throw this.#completionError(
      'Anthropic stream ended without message_stop',
      state,
      state.latestRaw,
    )
  }

  #startBlock(
    state: AnthropicAccumulator,
    event: JsonObject,
  ): Exclude<ProviderEvent, { type: 'completed' }> | undefined {
    const index = providerMetric(event.index)
    const block = providerObjectField(event, 'content_block')
    if (index === undefined || !block) return undefined
    if (!state.blocks.has(index) && state.blocks.size >= MAX_MESSAGE_PARTS) {
      throw new RangeError(
        `Anthropic content blocks exceed maximum count ${MAX_MESSAGE_PARTS}`,
      )
    }
    state.blocks.set(index, structuredClone(block))
    if (block.type !== 'tool_use') return undefined
    const initialInput = providerObjectField(block, 'input')
    state.toolArguments.set(
      index,
      initialInput && Object.keys(initialInput).length > 0
        ? JSON.stringify(initialInput)
        : '',
    )
    state.firstTokenAt ??= this.#now()
    return {
      type: 'tool.delta',
      index,
      id: typeof block.id === 'string' ? block.id : undefined,
      name: typeof block.name === 'string' ? block.name : undefined,
      raw: toProviderJson(event),
    }
  }

  #applyBlockDelta(
    state: AnthropicAccumulator,
    event: JsonObject,
  ): Exclude<ProviderEvent, { type: 'completed' }> | undefined {
    const index = providerMetric(event.index)
    const delta = providerObjectField(event, 'delta')
    if (index === undefined || !delta) return undefined
    const block = state.blocks.get(index)
    if (!block) {
      throw this.#completionError(
        'Anthropic sent a delta before content_block_start',
        state,
        event,
      )
    }
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      const current = typeof block.text === 'string' ? block.text : ''
      block.text = appendProviderText(current, delta.text, 'Anthropic text')
      state.streamedText = appendProviderText(
        state.streamedText,
        delta.text,
        'Anthropic streamed text',
      )
      state.firstTokenAt ??= this.#now()
      return {
        type: 'text.delta',
        delta: delta.text,
        raw: toProviderJson(event),
      }
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const current = typeof block.thinking === 'string' ? block.thinking : ''
      block.thinking = appendProviderText(
        current,
        delta.thinking,
        'Anthropic thinking',
      )
      state.streamedReasoning = appendProviderText(
        state.streamedReasoning,
        delta.thinking,
        'Anthropic streamed thinking',
      )
      state.firstTokenAt ??= this.#now()
      return {
        type: 'reasoning.delta',
        delta: delta.thinking,
        raw: toProviderJson(event),
      }
    }
    if (
      delta.type === 'signature_delta' &&
      typeof delta.signature === 'string'
    ) {
      const current = typeof block.signature === 'string' ? block.signature : ''
      block.signature = appendProviderText(
        current,
        delta.signature,
        'Anthropic thinking signature',
      )
      return undefined
    }
    if (
      delta.type === 'input_json_delta' &&
      typeof delta.partial_json === 'string'
    ) {
      const current = state.toolArguments.get(index) ?? ''
      state.toolArguments.set(
        index,
        appendProviderArguments(
          current,
          delta.partial_json,
          'Anthropic tool arguments',
        ),
      )
      state.firstTokenAt ??= this.#now()
      return {
        type: 'tool.delta',
        index,
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : undefined,
        argumentsDelta: delta.partial_json,
        raw: toProviderJson(event),
      }
    }
    return undefined
  }

  #stopBlock(state: AnthropicAccumulator, event: JsonObject): void {
    const index = providerMetric(event.index)
    if (index === undefined) return
    const block = state.blocks.get(index)
    if (!block) {
      throw this.#completionError(
        'Anthropic stopped an unknown content block',
        state,
        event,
      )
    }
    if (block.type === 'tool_use') {
      const argumentsText = state.toolArguments.get(index) ?? ''
      if (argumentsText) {
        let input: unknown
        try {
          input = JSON.parse(argumentsText)
        } catch {
          throw this.#completionError(
            'Anthropic returned invalid tool input JSON',
            state,
            event,
          )
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw this.#completionError(
            'Anthropic tool input must be a JSON object',
            state,
            event,
          )
        }
        block.input = toProviderJson(input)
      } else if (!providerObjectField(block, 'input')) {
        block.input = {}
      }
    }
    state.stoppedBlocks.add(index)
  }

  #complete(
    call: CompiledProviderCall,
    state: AnthropicAccumulator,
    terminalEvent: JsonObject,
  ): Extract<ProviderEvent, { type: 'completed' }> {
    if (state.blocks.size !== state.stoppedBlocks.size) {
      throw this.#completionError(
        'Anthropic message stopped before all content blocks completed',
        state,
        terminalEvent,
      )
    }
    const content = [...state.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => structuredClone(block))
    let text = ''
    const reasoningBlocks: string[] = []
    const toolCalls: ToolCall[] = []
    const intents = providerIntentFields(call.tools)
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text = appendProviderText(text, block.text, 'Anthropic response text')
      } else if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking
      ) {
        reasoningBlocks.push(block.thinking)
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (toolCalls.length >= MAX_MESSAGE_PARTS) {
          throw new RangeError(
            `Anthropic tool calls exceed maximum count ${MAX_MESSAGE_PARTS}`,
          )
        }
        toolCalls.push(
          normalizeProviderToolCall({
            id:
              typeof block.id === 'string'
                ? (block.id as CallId)
                : this.#createCallId(),
            name: block.name,
            arguments: providerObjectField(block, 'input') ?? {},
            intentFields: intents,
          }),
        )
      }
    }
    const reasoning = reasoningBlocks.join('\n\n') || state.streamedReasoning
    if (reasoning.length > MAX_MESSAGE_TEXT_LENGTH) {
      throw new RangeError(
        `Anthropic reasoning exceeds maximum length ${MAX_MESSAGE_TEXT_LENGTH}`,
      )
    }
    const parts: MessagePart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const call of toolCalls) {
      parts.push({
        type: 'tool_call',
        callId: call.id,
        name: call.toolId,
        arguments: structuredClone(call.args),
      })
    }
    const usage = normalizedAnthropicUsage(state.startUsage, state.deltaUsage)
    const message = toProviderJson({
      ...state.message,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: state.stopReason ?? null,
      stop_sequence: state.stopSequence ?? null,
      usage: {
        ...(state.startUsage &&
        typeof state.startUsage === 'object' &&
        !Array.isArray(state.startUsage)
          ? state.startUsage
          : {}),
        ...(state.deltaUsage &&
        typeof state.deltaUsage === 'object' &&
        !Array.isArray(state.deltaUsage)
          ? state.deltaUsage
          : {}),
      },
    })
    const rawResponse = toProviderJson(terminalEvent)
    const completedTiming = anthropicTiming(state, this.#now, rawResponse)
    const providerState = toProviderJson({
      providerId: this.#providerId,
      providerType: this.providerType,
      message,
    })
    if (parts.length === 0) {
      throw new ProviderCompletionError(
        reasoning
          ? 'Anthropic returned thinking without an assistant answer'
          : 'Anthropic completed with an empty assistant turn',
        {
          rawResponse,
          providerState,
          usage: structuredClone(usage.raw),
          timing: completedTiming,
        },
      )
    }
    return {
      type: 'completed',
      turn: {
        parts,
        toolCalls,
        ...(reasoning ? { normalizedReasoningText: reasoning } : {}),
        providerContinuation: {
          schemaVersion: 2,
          providerType: this.providerType,
          format: ANTHROPIC_CONTINUATION_FORMAT,
          data: {
            partsHash: canonicalHash(parts),
            content: toProviderJson(content),
          },
        },
        usage,
        finishReason: anthropicFinishReason(
          state.stopReason,
          toolCalls.length > 0,
        ),
      },
      rawResponse,
      providerState,
      timing: completedTiming,
    }
  }

  #completionError(
    message: string,
    state: AnthropicAccumulator,
    raw: JsonValue,
  ): ProviderCompletionError {
    const rawResponse = toProviderJson(raw)
    const diagnostics: ProviderResponseDiagnostics = {
      rawResponse,
      providerState: toProviderJson({
        providerId: this.#providerId,
        providerType: this.providerType,
        message: state.message,
        content: [...state.blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => block),
        stopReason: state.stopReason ?? null,
      }),
      usage: normalizedAnthropicUsage(state.startUsage, state.deltaUsage).raw,
      timing: anthropicTiming(state, this.#now, rawResponse),
    }
    return new ProviderCompletionError(message, diagnostics)
  }
}
