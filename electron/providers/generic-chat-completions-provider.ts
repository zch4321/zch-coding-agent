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
import type {
  CompiledProviderCall,
  ModelProvider,
  ProviderCompileInput,
  ProviderEvent,
  ProviderStreamContext,
} from './provider'

export interface GenericChatCompletionsProviderOptions {
  providerId: string
  baseURL: string
  endpoint?: string
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => number
  createCallId?: () => CallId
  timeoutMs?: number
}

/** Implements the generic OpenAI-compatible Chat Completions fallback. */
export class GenericChatCompletionsProvider implements ModelProvider {
  readonly providerType = 'generic.chat-completions' as const
  readonly #providerId: string
  readonly #transport: HttpSseTransport
  readonly #now: () => number
  readonly #createCallId: () => CallId

  constructor(options: GenericChatCompletionsProviderOptions) {
    this.#providerId = options.providerId
    this.#transport = new HttpSseTransport({
      providerId: options.providerId,
      endpoint:
        options.endpoint ?? resolveChatCompletionsEndpoint(options.baseURL),
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })
    this.#now = options.now ?? (() => performance.now())
    this.#createCallId = options.createCallId ?? createChatCallId
  }

  /** Compiles canonical input without vendor-specific request fields. */
  compile(input: ProviderCompileInput): CompiledProviderCall {
    if (input.route.providerType !== this.providerType) {
      throw new TypeError(
        `Route Provider ${input.route.providerType} does not match ${this.providerType}`,
      )
    }
    const normalizedMessages = compileChatMessages(
      input.history,
      this.providerType,
    )
    const tools = structuredClone(input.tools)
    const wireTools = compileChatTools(tools)
    const request = {
      model: input.route.model,
      messages: normalizedMessages,
      ...(wireTools.length > 0 ? { tools: wireTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(input.structuredOutput
        ? { response_format: { type: 'json_object' } }
        : {}),
    } as JsonObject
    return {
      request,
      normalizedMessages: structuredClone(normalizedMessages),
      tools,
    }
  }

  /** Sends and normalizes one generic Chat Completions request. */
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
