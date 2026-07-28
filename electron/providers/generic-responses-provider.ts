import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
} from '../../shared/durable'
import type { CallId } from '../../shared/ids'
import { type JsonObject, type JsonValue } from '../../shared/json'
import type { MessagePart, MessageRecord } from '../../shared/message'
import { renderLiveUserInterjection } from '../../shared/live-interjection'
import { resolveResponsesEndpoint } from '../../shared/model-route'
import { canonicalHash, messageText } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'
import { HttpSseTransport } from './http-sse-transport'
import {
  ProviderCompletionError,
  type CompiledProviderCall,
  type ModelProvider,
  type ProviderCompileInput,
  type ProviderEvent,
  type ProviderResponseDiagnostics,
  type ProviderStreamContext,
  type ProviderTiming,
  type ProviderToolDefinition,
  type ProviderUsage,
} from './provider'
import {
  appendProviderArguments,
  appendProviderText,
  createProviderCallId,
  normalizeProviderToolCall,
  parseProviderArguments,
  providerIntentFields,
  providerJsonBytes,
  providerMetric,
  providerObjectField,
  toProviderJson,
} from './provider-shared'

export const RESPONSES_CONTINUATION_FORMAT = 'responses.output-items.v1'

interface ResponsesAccumulator {
  requestStart: number
  firstTokenAt?: number
  latestRaw: JsonValue
  streamedReasoning: string
  streamedText: string
  toolCalls: Map<number, { id?: string; name?: string; argumentsText: string }>
}

export interface GenericResponsesProviderOptions {
  providerId: string
  baseURL: string
  endpoint?: string
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
  timeoutMs?: number
}

function responseTools(tools: readonly ProviderToolDefinition[]): JsonValue[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.inputSchema),
    strict: false,
  }))
}

function canonicalAssistantItems(
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): JsonObject[] {
  const items: JsonObject[] = []
  const text = messageText(record)
  if (text) {
    items.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const part of record.parts) {
    if (part.type !== 'tool_call') continue
    items.push({
      type: 'function_call',
      call_id: part.callId,
      name: part.name,
      arguments: JSON.stringify(part.arguments),
      status: 'completed',
    })
  }
  return items
}

function responseContinuationItems(
  record: Extract<MessageRecord, { kind: 'assistant_turn' }>,
): JsonObject[] | undefined {
  const continuation = record.providerContinuation
  if (
    !continuation ||
    continuation.providerType !== 'generic.responses' ||
    continuation.format !== RESPONSES_CONTINUATION_FORMAT
  ) {
    return undefined
  }
  const data = continuation.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Responses continuation payload is corrupt')
  }
  if (data.partsHash !== canonicalHash(record.parts)) return undefined
  if (
    !Array.isArray(data.outputItems) ||
    data.outputItems.some(
      (item) => !item || typeof item !== 'object' || Array.isArray(item),
    )
  ) {
    throw new TypeError('Responses continuation output items are corrupt')
  }
  return structuredClone(data.outputItems) as JsonObject[]
}

function compileResponseRecord(record: MessageRecord): JsonObject[] {
  switch (record.kind) {
    case 'system_instruction':
      return []
    case 'assistant_turn':
      return (
        responseContinuationItems(record) ?? canonicalAssistantItems(record)
      )
    case 'tool_result': {
      const result = record.parts[0]
      return [
        {
          type: 'function_call_output',
          call_id: result.callId,
          output: JSON.stringify(result.content),
        },
      ]
    }
    case 'interjection':
      return [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: renderLiveUserInterjection(messageText(record)),
            },
          ],
        },
      ]
    default:
      return [
        {
          role: 'user',
          content: [{ type: 'input_text', text: messageText(record) }],
        },
      ]
  }
}

function compileResponseInput(history: ProviderCompileInput['history']): {
  instructions?: string
  items: JsonObject[]
} {
  const instructions = history.messages
    .filter((record) => record.kind === 'system_instruction')
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  return {
    ...(instructions ? { instructions } : {}),
    items: history.messages.flatMap(compileResponseRecord),
  }
}

function responseTextFormat(
  structuredOutput: ProviderCompileInput['structuredOutput'],
): JsonObject | undefined {
  if (!structuredOutput) return undefined
  if (structuredOutput.type === 'json_object') return { type: 'json_object' }
  return {
    type: 'json_schema',
    name: structuredOutput.name,
    strict: true,
    schema: structuredClone(structuredOutput.schema),
  }
}

function responseUsage(value: JsonValue): ProviderUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { raw: value }
  }
  const usage = value as JsonObject
  const inputDetails = providerObjectField(usage, 'input_tokens_details')
  const outputDetails = providerObjectField(usage, 'output_tokens_details')
  return {
    promptTokens: providerMetric(usage.input_tokens),
    completionTokens: providerMetric(usage.output_tokens),
    totalTokens: providerMetric(usage.total_tokens),
    reasoningTokens: providerMetric(outputDetails?.reasoning_tokens),
    cacheHitTokens: providerMetric(inputDetails?.cached_tokens),
    raw: structuredClone(value),
  }
}

function responseOutput(response: JsonObject): JsonObject[] {
  if (!Array.isArray(response.output)) return []
  return response.output.filter((item): item is JsonObject =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  )
}

function responseText(output: readonly JsonObject[]): {
  text: string
  refusal: boolean
} {
  let text = ''
  let refusal = false
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        continue
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        text = appendProviderText(text, content.text, 'Responses text')
      } else if (
        content.type === 'refusal' &&
        typeof content.refusal === 'string'
      ) {
        refusal = true
        text = appendProviderText(text, content.refusal, 'Responses refusal')
      }
    }
  }
  return { text, refusal }
}

function responseReasoning(output: readonly JsonObject[]): string {
  const summaries: string[] = []
  for (const item of output) {
    if (item.type !== 'reasoning' || !Array.isArray(item.summary)) continue
    for (const summary of item.summary) {
      if (
        summary &&
        typeof summary === 'object' &&
        !Array.isArray(summary) &&
        typeof summary.text === 'string' &&
        summary.text
      ) {
        summaries.push(summary.text)
      }
    }
  }
  const reasoning = summaries.join('\n\n')
  if (reasoning.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new RangeError(
      `Responses reasoning exceeds maximum length ${MAX_MESSAGE_TEXT_LENGTH}`,
    )
  }
  return reasoning
}

function responseToolCalls(
  output: readonly JsonObject[],
  tools: readonly ProviderToolDefinition[],
  createCallId: () => CallId,
): ToolCall[] {
  const calls: ToolCall[] = []
  const intents = providerIntentFields(tools)
  for (const item of output) {
    if (item.type !== 'function_call' || typeof item.name !== 'string') {
      continue
    }
    if (calls.length >= MAX_MESSAGE_PARTS) {
      throw new RangeError(
        `Responses tool calls exceed maximum count ${MAX_MESSAGE_PARTS}`,
      )
    }
    const id =
      typeof item.call_id === 'string'
        ? (item.call_id as CallId)
        : createCallId()
    const argumentsText =
      typeof item.arguments === 'string' ? item.arguments : ''
    calls.push(
      normalizeProviderToolCall({
        id,
        name: item.name,
        arguments: parseProviderArguments(argumentsText),
        intentFields: intents,
      }),
    )
  }
  return calls
}

function responseFinishReason(input: {
  response: JsonObject
  refusal: boolean
  hasToolCalls: boolean
}): string {
  if (input.response.status === 'incomplete') {
    const details = providerObjectField(input.response, 'incomplete_details')
    if (details?.reason === 'max_output_tokens') return 'truncated'
    if (details?.reason === 'content_filter') return 'content_filter'
    return typeof details?.reason === 'string' ? details.reason : 'incomplete'
  }
  if (input.refusal) return 'refusal'
  if (input.hasToolCalls) return 'tool_calls'
  return 'completed'
}

function timing(
  state: ResponsesAccumulator,
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

/** Implements the generic OpenAI-compatible Responses fallback. */
export class GenericResponsesProvider implements ModelProvider {
  readonly providerType = 'generic.responses' as const
  readonly #providerId: string
  readonly #transport: HttpSseTransport
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: GenericResponsesProviderOptions) {
    this.#providerId = options.providerId
    this.#transport = new HttpSseTransport({
      providerId: options.providerId,
      endpoint: options.endpoint ?? resolveResponsesEndpoint(options.baseURL),
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId = options.createCallId ?? createProviderCallId
  }

  /** Compiles canonical history into stateless Responses input items. */
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
    const compiled = compileResponseInput(input.history)
    const tools = structuredClone(input.tools)
    const wireTools = responseTools(tools)
    const format = responseTextFormat(input.structuredOutput)
    const reasoning =
      input.route.reasoning === 'off'
        ? { effort: 'none' }
        : { effort: input.route.reasoning, summary: 'auto' }
    const request = {
      model: input.route.model,
      ...(compiled.instructions ? { instructions: compiled.instructions } : {}),
      input: compiled.items,
      ...(wireTools.length > 0 ? { tools: wireTools } : {}),
      stream: true,
      store: false,
      max_output_tokens: input.maxOutputTokens,
      reasoning,
      ...(input.route.reasoning === 'off'
        ? {}
        : { include: ['reasoning.encrypted_content'] }),
      ...(format ? { text: { format } } : {}),
    } as JsonObject
    return {
      request,
      normalizedMessages: structuredClone(compiled.items),
      tools,
    }
  }

  /** Sends one stateless Responses request and normalizes typed SSE events. */
  async *stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent> {
    const state: ResponsesAccumulator = {
      requestStart: this.#now(),
      latestRaw: null,
      streamedReasoning: '',
      streamedText: '',
      toolCalls: new Map(),
    }
    for await (const event of this.#transport.postJson(
      structuredClone(call.request),
      context.signal,
    )) {
      state.latestRaw = toProviderJson(event)
      const eventType = typeof event.type === 'string' ? event.type : ''
      if (eventType === 'error' || eventType === 'response.failed') {
        throw this.#completionError('Responses request failed', state, event)
      }
      if (eventType === 'response.output_item.added') {
        this.#rememberToolItem(state, event)
        continue
      }
      if (
        eventType === 'response.output_text.delta' ||
        eventType === 'response.refusal.delta'
      ) {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (!delta) continue
        state.firstTokenAt ??= this.#now()
        state.streamedText = appendProviderText(
          state.streamedText,
          delta,
          'Responses streamed text',
        )
        yield { type: 'text.delta', delta, raw: toProviderJson(event) }
        continue
      }
      if (
        eventType === 'response.reasoning_summary_text.delta' ||
        eventType === 'response.reasoning_text.delta'
      ) {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (!delta) continue
        state.firstTokenAt ??= this.#now()
        state.streamedReasoning = appendProviderText(
          state.streamedReasoning,
          delta,
          'Responses streamed reasoning',
        )
        yield { type: 'reasoning.delta', delta, raw: toProviderJson(event) }
        continue
      }
      if (eventType === 'response.function_call_arguments.delta') {
        const toolEvent = this.#toolDelta(state, event)
        if (toolEvent) yield toolEvent
        continue
      }
      if (
        eventType === 'response.completed' ||
        eventType === 'response.incomplete'
      ) {
        const response = providerObjectField(event, 'response')
        if (!response) {
          throw this.#completionError(
            'Responses terminal event is missing its response',
            state,
            event,
          )
        }
        yield this.#complete(call, state, response)
        return
      }
    }
    throw this.#completionError(
      'Responses stream ended without a terminal response',
      state,
      state.latestRaw,
    )
  }

  #rememberToolItem(state: ResponsesAccumulator, event: JsonObject): void {
    const item = providerObjectField(event, 'item')
    const index = providerMetric(event.output_index)
    if (!item || item.type !== 'function_call' || index === undefined) return
    state.toolCalls.set(index, {
      ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
    })
  }

  #toolDelta(
    state: ResponsesAccumulator,
    event: JsonObject,
  ): Exclude<ProviderEvent, { type: 'completed' }> | undefined {
    const index = providerMetric(event.output_index)
    const delta = typeof event.delta === 'string' ? event.delta : ''
    if (index === undefined || !delta) return undefined
    if (
      !state.toolCalls.has(index) &&
      state.toolCalls.size >= MAX_MESSAGE_PARTS
    ) {
      throw new RangeError(
        `Responses tool calls exceed maximum count ${MAX_MESSAGE_PARTS}`,
      )
    }
    const current = state.toolCalls.get(index) ?? { argumentsText: '' }
    current.argumentsText = appendProviderArguments(
      current.argumentsText,
      delta,
      'Responses tool arguments',
    )
    state.toolCalls.set(index, current)
    state.firstTokenAt ??= this.#now()
    return {
      type: 'tool.delta',
      index,
      id: current.id,
      name: current.name,
      argumentsDelta: delta,
      raw: toProviderJson(event),
    }
  }

  #complete(
    call: CompiledProviderCall,
    state: ResponsesAccumulator,
    response: JsonObject,
  ): Extract<ProviderEvent, { type: 'completed' }> {
    const output = responseOutput(response)
    const visible = responseText(output)
    const reasoning = responseReasoning(output) || state.streamedReasoning
    const toolCalls = responseToolCalls(output, call.tools, this.#createCallId)
    const parts: MessagePart[] = []
    if (visible.text) parts.push({ type: 'text', text: visible.text })
    for (const toolCall of toolCalls) {
      parts.push({
        type: 'tool_call',
        callId: toolCall.id,
        name: toolCall.toolId,
        arguments: structuredClone(toolCall.args),
      })
    }
    const rawResponse = toProviderJson(response)
    const completedTiming = timing(state, this.#now, rawResponse)
    const usage = responseUsage(response.usage ?? null)
    const providerState = toProviderJson({
      providerId: this.#providerId,
      providerType: this.providerType,
      responseId: response.id ?? null,
      status: response.status ?? null,
      output,
    })
    if (parts.length === 0) {
      throw new ProviderCompletionError(
        reasoning
          ? 'Responses returned reasoning without an assistant answer'
          : 'Responses completed with an empty assistant turn',
        {
          rawResponse,
          providerState,
          usage: structuredClone(usage.raw),
          timing: completedTiming,
        },
      )
    }
    const continuationData = {
      partsHash: canonicalHash(parts),
      outputItems: toProviderJson(output),
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
          format: RESPONSES_CONTINUATION_FORMAT,
          data: continuationData,
        },
        usage,
        finishReason: responseFinishReason({
          response,
          refusal: visible.refusal,
          hasToolCalls: toolCalls.length > 0,
        }),
      },
      rawResponse,
      providerState,
      timing: completedTiming,
    }
  }

  #completionError(
    message: string,
    state: ResponsesAccumulator,
    raw: JsonValue,
  ): ProviderCompletionError {
    const response =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? providerObjectField(raw, 'response')
        : undefined
    const usage = response?.usage ?? null
    const rawResponse = toProviderJson(raw)
    const diagnostics: ProviderResponseDiagnostics = {
      rawResponse,
      providerState: toProviderJson({
        providerId: this.#providerId,
        providerType: this.providerType,
        streamedText: state.streamedText,
        streamedReasoning: state.streamedReasoning,
      }),
      usage: toProviderJson(usage),
      timing: timing(state, this.#now, rawResponse),
    }
    return new ProviderCompletionError(message, diagnostics)
  }
}
