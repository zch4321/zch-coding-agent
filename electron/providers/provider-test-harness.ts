import type { ProviderType } from '../../shared/config'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessagePart } from '../../shared/message'
import { canonicalHash } from '../session/canonical-history'
import type { ToolCall } from '../tools/types'
import {
  CHAT_COMPLETIONS_CONTINUATION_FORMAT,
  normalizeChatFinishReason,
  normalizeChatUsage,
} from './chat-completions-shared'
import { DeepSeekProvider } from './deepseek-provider'
import { GenericChatCompletionsProvider } from './generic-chat-completions-provider'
import {
  ProviderCompletionError,
  compiledSyntheticCompactCall,
  syntheticCompactEvents,
  type CompiledProviderCall,
  type CompiledProviderCompactCall,
  type ModelProvider,
  type ProviderCompactEvent,
  type ProviderCompactInput,
  type ProviderCompactMode,
  type ProviderCompileInput,
  type ProviderEvent,
  type ProviderStreamContext,
  type ProviderToolDefinition,
} from './provider'

export interface TestProviderStreamRequest extends CompiledProviderCall {
  providerRequest: JsonObject
  toolDefinitions: ProviderToolDefinition[]
  signal: AbortSignal
}

export type ScriptedProviderEvent =
  | Exclude<ProviderEvent, { type: 'completed' }>
  | {
      type: 'completed'
      rawResponse?: JsonValue
      turn: JsonObject
      toolCalls?: ToolCall[]
      usage?: JsonValue
      finishReason?: string
      providerState?: JsonValue
      timing?: JsonValue
    }

function supportedProviderType(value: string): ProviderType {
  if (
    value !== 'deepseek.chat-completions' &&
    value !== 'generic.chat-completions'
  ) {
    throw new TypeError(`Unsupported scripted Provider Type: ${value}`)
  }
  return value
}

function compileTestCall(
  input: ProviderCompileInput,
  providerType: ProviderType,
): CompiledProviderCall {
  const routeProviderType = supportedProviderType(input.route.providerType)
  if (routeProviderType !== providerType) {
    throw new TypeError(
      `Route Provider ${routeProviderType} does not match scripted ${providerType}`,
    )
  }
  return providerType === 'deepseek.chat-completions'
    ? new DeepSeekProvider({
        baseURL: 'https://provider.invalid/v1',
        apiKey: 'test-only',
      }).compile(input)
    : new GenericChatCompletionsProvider({
        providerId: 'test-only',
        baseURL: 'https://provider.invalid/v1',
        apiKey: 'test-only',
      }).compile(input)
}

function timing(value: JsonValue | undefined): {
  ttftMs: number | null
  totalMs: number
  responseBytes: number
} {
  const record =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    ttftMs: typeof record.ttftMs === 'number' ? record.ttftMs : null,
    totalMs: typeof record.totalMs === 'number' ? record.totalMs : 0,
    responseBytes:
      typeof record.responseBytes === 'number' ? record.responseBytes : 0,
  }
}

function normalizeCompletion(
  event: Extract<ScriptedProviderEvent, { type: 'completed' }>,
  providerType: ProviderType,
): Extract<ProviderEvent, { type: 'completed' }> {
  const toolCalls = structuredClone(event.toolCalls ?? [])
  const content =
    typeof event.turn.content === 'string' ? event.turn.content : ''
  const reasoning =
    typeof event.turn.reasoning_content === 'string'
      ? event.turn.reasoning_content
      : ''
  const parts: MessagePart[] = content ? [{ type: 'text', text: content }] : []
  for (const call of toolCalls) {
    parts.push({
      type: 'tool_call',
      callId: call.id,
      name: call.toolId,
      arguments: structuredClone(call.args),
    })
  }
  const responseTiming = timing(event.timing)
  const usage = normalizeChatUsage(event.usage ?? null)
  if (parts.length === 0) {
    throw new ProviderCompletionError(
      reasoning
        ? 'Provider returned reasoning without an assistant answer; retry the request'
        : 'Provider completed with an empty assistant turn',
      {
        rawResponse: structuredClone(event.rawResponse ?? null),
        providerState: structuredClone(event.providerState ?? null),
        usage: structuredClone(usage.raw),
        timing: responseTiming,
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
        providerType,
        format: CHAT_COMPLETIONS_CONTINUATION_FORMAT,
        data: {
          partsHash: canonicalHash(parts),
          assistant: structuredClone(event.turn),
        },
      },
      usage,
      finishReason: normalizeChatFinishReason(
        event.finishReason,
        toolCalls.length > 0,
      ),
    },
    rawResponse: structuredClone(event.rawResponse ?? null),
    providerState: structuredClone(event.providerState ?? null),
    timing: responseTiming,
  }
}

/** Adapts concise scripted transport fixtures to the flat ModelProvider API. */
export abstract class ScriptedProviderHarness implements ModelProvider {
  readonly providerType: ProviderType

  constructor(providerType: ProviderType = 'deepseek.chat-completions') {
    this.providerType = providerType
  }

  /** Compiles canonical history into the Chat-shaped data inspected by tests. */
  compile(input: ProviderCompileInput): CompiledProviderCall {
    return compileTestCall(input, this.providerType)
  }

  /** Exposes deterministic synthetic compaction to runtime test fixtures. */
  compactModes(): readonly ProviderCompactMode[] {
    return ['synthetic']
  }

  /** Compiles scripted compaction as a no-tools test Provider request. */
  compileCompact(
    input: ProviderCompactInput,
    mode: ProviderCompactMode = 'synthetic',
  ): CompiledProviderCompactCall {
    if (mode !== 'synthetic') {
      throw new TypeError(
        'Scripted Provider only supports synthetic compaction',
      )
    }
    return compiledSyntheticCompactCall(
      this.compile({
        history: input.history,
        route: input.route,
        tools: [],
        maxOutputTokens: input.maxOutputTokens,
      }),
      input.instructions,
    )
  }

  /** Implements one fixture's scripted event sequence. */
  abstract run(
    request: TestProviderStreamRequest,
  ): AsyncIterable<ScriptedProviderEvent>

  /** Normalizes scripted legacy-shaped completions for runtime integration tests. */
  async *stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent> {
    const request: TestProviderStreamRequest = {
      ...structuredClone(call),
      providerRequest: structuredClone(call.request),
      toolDefinitions: structuredClone(call.tools),
      signal: context.signal,
    }
    for await (const event of this.run(request)) {
      yield event.type === 'completed'
        ? normalizeCompletion(event, this.providerType)
        : event
    }
  }

  /** Adapts scripted provider output into a synthetic compact checkpoint. */
  compact(
    call: CompiledProviderCompactCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderCompactEvent> {
    return syntheticCompactEvents(
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
  }
}
