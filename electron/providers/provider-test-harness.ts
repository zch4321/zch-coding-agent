import type { ProviderType } from '../../shared/config'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessagePart } from '../../shared/message'
import type { ToolCall } from '../tools/types'
import { normalizeChatUsage } from './chat-completions-shared'
import { DeepSeekProvider } from './deepseek-provider'
import { GenericChatCompletionsProvider } from './generic-chat-completions-provider'
import type {
  CompiledProviderCall,
  ModelProvider,
  ProviderCompileInput,
  ProviderEvent,
  ProviderStreamContext,
  ProviderToolDefinition,
} from './provider'

export interface TestProviderStreamRequest extends CompiledProviderCall {
  providerRequest: JsonObject
  toolDefinitions: ProviderToolDefinition[]
  signal: AbortSignal
  onRequest?: (snapshot: {
    normalizedMessages: JsonValue[]
    providerRequest: JsonValue
    requestBytes: number
    prefixHash: string
  }) => Promise<void> | void
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

function compileTestCall(input: ProviderCompileInput): CompiledProviderCall {
  const providerType = supportedProviderType(input.route.providerType)
  const compiled =
    providerType === 'deepseek.chat-completions'
      ? new DeepSeekProvider({
          baseURL: 'https://provider.invalid/v1',
          apiKey: 'test-only',
        }).compile(input)
      : new GenericChatCompletionsProvider({
          providerId: 'test-only',
          baseURL: 'https://provider.invalid/v1',
          apiKey: 'test-only',
        }).compile(input)
  return {
    ...compiled,
    providerRequest: compiled.request,
    toolDefinitions: compiled.tools,
  } as CompiledProviderCall
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
  if (parts.length === 0) {
    if (reasoning) {
      throw new TypeError(
        'Provider returned reasoning without an assistant answer; retry the request',
      )
    }
    throw new TypeError('Provider completed with an empty assistant turn')
  }
  const finishReason =
    event.finishReason === 'length'
      ? 'truncated'
      : toolCalls.length > 0
        ? 'tool_calls'
        : 'completed'
  return {
    type: 'completed',
    turn: {
      parts,
      toolCalls,
      ...(reasoning ? { normalizedReasoningText: reasoning } : {}),
      usage: normalizeChatUsage(event.usage ?? null),
      finishReason,
    },
    rawResponse: structuredClone(event.rawResponse ?? null),
    providerState: structuredClone(event.providerState ?? null),
    timing: timing(event.timing),
  }
}

/** Adapts concise scripted transport fixtures to the flat ModelProvider API. */
export abstract class ScriptedProviderHarness implements ModelProvider {
  readonly providerType = 'deepseek.chat-completions' as const

  /** Compiles canonical history into the Chat-shaped data inspected by tests. */
  compile(input: ProviderCompileInput): CompiledProviderCall {
    return compileTestCall(input)
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
      yield event.type === 'completed' ? normalizeCompletion(event) : event
    }
  }
}
