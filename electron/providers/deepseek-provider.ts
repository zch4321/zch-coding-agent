import type { CallId } from '../../shared/ids'
import type { JsonObject } from '../../shared/json'
import { resolveChatCompletionsEndpoint } from '../../shared/model-route'
import {
  accumulateChatCompletionChunk,
  compileChatMessages,
  compileChatTools,
  completeChatCompletion,
  createChatCompletionAccumulator,
  createChatCallId,
} from './chat-completions-shared'
import { HttpSseTransport } from './http-sse-transport'
import {
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
} from './provider'

export interface DeepSeekProviderOptions {
  providerId?: string
  baseURL: string
  endpoint?: string
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
  timeoutMs?: number
}

/** Implements DeepSeek's Chat Completions request and response behavior. */
export class DeepSeekProvider implements ModelProvider {
  readonly providerType = 'deepseek.chat-completions' as const
  readonly #providerId: string
  readonly #transport: HttpSseTransport
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: DeepSeekProviderOptions) {
    this.#providerId = options.providerId ?? 'deepseek'
    this.#transport = new HttpSseTransport({
      providerId: this.#providerId,
      endpoint:
        options.endpoint ?? resolveChatCompletionsEndpoint(options.baseURL),
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId = options.createCallId ?? createChatCallId
  }

  /** Compiles canonical input with DeepSeek thinking parameters. */
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
    const normalizedMessages = compileChatMessages(
      input.history,
      this.providerType,
      input.route,
    )
    const tools = structuredClone(input.tools)
    const wireTools = compileChatTools(tools)
    const request = {
      model: input.route.model,
      messages: normalizedMessages,
      ...(wireTools.length > 0 ? { tools: wireTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: input.maxOutputTokens,
      ...(input.structuredOutput
        ? { response_format: { type: 'json_object' } }
        : {}),
      thinking: {
        type: input.route.reasoning === 'off' ? 'disabled' : 'enabled',
      },
      ...(input.route.reasoning === 'off'
        ? {}
        : { reasoning_effort: input.route.reasoning }),
    } as JsonObject
    return {
      request,
      normalizedMessages: structuredClone(normalizedMessages),
      tools,
    }
  }

  /** Exposes portable summarization as this protocol's only compact strategy. */
  compactModes(): readonly ProviderCompactMode[] {
    return ['synthetic']
  }

  /** Compiles a no-tools DeepSeek request for synthetic compaction. */
  compileCompact(
    input: ProviderCompactInput,
    mode: ProviderCompactMode = 'synthetic',
  ): CompiledProviderCompactCall {
    if (mode !== 'synthetic') {
      throw new TypeError('DeepSeek only supports synthetic compaction')
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

  /** Streams a synthetic text checkpoint through DeepSeek. */
  compact(
    call: CompiledProviderCompactCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderCompactEvent> {
    if (call.mode !== 'synthetic') {
      throw new TypeError('DeepSeek only supports synthetic compaction')
    }
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

  /** Sends and normalizes one compiled DeepSeek request. */
  async *stream(
    call: CompiledProviderCall,
    context: ProviderStreamContext,
  ): AsyncIterable<ProviderEvent> {
    const accumulator = createChatCompletionAccumulator(call.tools, this.#now())
    for await (const chunk of this.#transport.postJson(
      structuredClone(call.request),
      context.signal,
    )) {
      yield* accumulateChatCompletionChunk(accumulator, chunk, this.#now)
    }
    yield completeChatCompletion(accumulator, {
      providerId: this.#providerId,
      providerType: this.providerType,
      now: this.#now,
      createCallId: this.#createCallId,
    })
  }
}
