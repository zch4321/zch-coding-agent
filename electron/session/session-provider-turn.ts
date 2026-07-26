import type { ProviderPublicConfig } from '../../shared/config'
import type { CallId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessagePart } from '../../shared/message'
import type { ConfigStore } from '../config/store'
import type { PluginEventBus } from '../plugins/event-bus'
import { OpenAICompatibleProvider } from '../providers/deepseek-provider'
import {
  assertChatCompletionsRequestDto,
  chatAdapter,
} from '../providers/chat-completions-adapter'
import type { CompletedAssistantTurn } from '../providers/provider-protocol'
import type {
  ProviderEvent,
  ProviderRequestSnapshot,
} from '../providers/provider'
import { normalizeLlmUsage } from '../providers/usage'
import type { ToolCall } from '../tools/types'
import { ContextBudgetError, estimateJsonTokens } from '../tools/context-budget'
import type { ToolRegistry } from '../tools/tool-registry'
import { id, redactJsonSecrets, toJsonValue } from './session-common'
import {
  assertAssistantTurnCandidate,
  canonicalTraceSource,
} from './canonical-history'
import { modelPromptBudget } from './session-run-utils'
import { promptResources, selectPromptMessages } from './prompt-harness'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import type { PromptRegistry } from '../prompts/registry'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import {
  appendAgentsContextIfChanged,
  appendRuntimeContextIfChanged,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'

export interface ProviderTurnResult {
  parts: MessagePart[]
  toolCalls: ToolCall[]
  text: string
  reasoning: string
  finishReason: string
  continuation?: {
    schemaVersion: 1
    adapterId: string
    format: string
    data: JsonValue
  }
}

const MUTABLE_REQUEST_FIELDS = new Set([
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'stop',
  'seed',
  'logprobs',
  'top_logprobs',
])
const CREDENTIAL_FIELD =
  /^(?:authorization|api[-_]?key|credential|password|secret|access[-_]?token|bearer)$/iu

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }
  return toJsonValue(value) as JsonObject
}

function assertImmutableRequest(
  original: JsonObject,
  candidate: JsonObject,
): void {
  for (const field of new Set([
    ...Object.keys(original),
    ...Object.keys(candidate),
  ])) {
    if (MUTABLE_REQUEST_FIELDS.has(field)) continue
    if (JSON.stringify(candidate[field]) !== JSON.stringify(original[field])) {
      throw new TypeError(
        `beforeLLMCall cannot modify protected request field: ${field}`,
      )
    }
  }
  assertNoCredentialFields(candidate)
  assertChatCompletionsRequestDto(candidate)
}

function assertNoCredentialFields(value: JsonValue, path = 'request'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoCredentialFields(item, `${path}[${index}]`),
    )
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [field, nested] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(field)) {
      throw new TypeError(
        `beforeLLMCall cannot add credential field: ${path}.${field}`,
      )
    }
    assertNoCredentialFields(nested, `${path}.${field}`)
  }
}

/** Runs provider-turn lifecycle, plugin hooks, streaming provider calls, and tool validation. */
export class SessionProviderTurnRunner {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #pluginBus: PluginEventBus | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #projectMetadata: ProjectMetadataStore | undefined
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #getWorkspaceConcurrency: (
    session: SessionState,
  ) => WorkspaceConcurrencyContext

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    pluginBus?: PluginEventBus
    promptRegistry?: PromptRegistry
    projectMetadata?: ProjectMetadataStore
    fetchImpl?: typeof fetch
    providerFactory: SessionManagerOptions['providerFactory']
    onDiagnostic: (message: string, error?: unknown) => void
    emit: (session: SessionState, event: AgentEventDraft) => void
    getWorkspaceConcurrency?: (
      session: SessionState,
    ) => WorkspaceConcurrencyContext
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#pluginBus = options.pluginBus
    this.#promptRegistry = options.promptRegistry
    this.#projectMetadata = options.projectMetadata
    this.#fetchImpl = options.fetchImpl
    this.#providerFactory = options.providerFactory
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
  }

  /** Builds an immutable provider request, invokes the provider, and returns its normalized turn. */
  async callProvider(
    session: SessionState,
    run: ActiveRun,
    setRunCalling: () => void,
  ): Promise<ProviderTurnResult> {
    setRunCalling()
    const binding = run.routes?.main
    if (!binding) throw new Error('Run model routes were not resolved')
    const config = this.#configStore.getPublicConfig()
    const tools = this.#toolRegistry.providerDefinitions()

    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: binding.snapshot.providerId,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      reason: 'provider_call',
      workspaceConcurrency: this.#getWorkspaceConcurrency(session),
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      signal: run.controller.signal,
    })
    await appendAgentsContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: binding.snapshot.providerId,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      signal: run.controller.signal,
    })

    const selection = selectPromptMessages({
      state: session,
      tools,
      maxPromptTokens: modelPromptBudget(binding.modelProfile),
      estimation: config.limits.tokenEstimation,
    })
    const adapter = chatAdapter(binding.snapshot.adapterId)
    const compiled = adapter.compile({
      history: {
        sessionId: session.sessionId,
        messages: selection.messages,
        sourceHash: selection.promptBuild.sourceHash,
      },
      route: binding.snapshot,
      tools,
    })
    const immutableBody = structuredClone(compiled.body)
    let body = structuredClone(compiled.body)
    const hookResult = await this.#pluginBus?.emit('beforeLLMCall', {
      version: 2,
      sessionId: session.sessionId,
      runId: run.runId,
      adapterId: adapter.id,
      route: binding.snapshot,
      request: body,
      params: {},
    })

    for (const patch of hookResult?.patches ?? []) {
      for (const field of Object.keys(patch)) {
        if (field !== 'request' && field !== 'params') {
          throw new TypeError(
            `beforeLLMCall cannot modify protected field: ${field}`,
          )
        }
      }
      if (patch.request) body = jsonObject(patch.request, 'Hook request')
      if (patch.params) {
        for (const [key, value] of Object.entries(patch.params)) {
          if (!MUTABLE_REQUEST_FIELDS.has(key) || key === 'messages') {
            throw new TypeError(
              `beforeLLMCall cannot modify unsupported parameter: ${key}`,
            )
          }
          body[key] = structuredClone(value)
        }
      }
      assertImmutableRequest(immutableBody, body)
    }
    assertImmutableRequest(immutableBody, body)

    const promptBudget = modelPromptBudget(binding.modelProfile)
    if (
      estimateJsonTokens(body, config.limits.tokenEstimation) > promptBudget
    ) {
      throw new ContextBudgetError(
        'A beforeLLMCall hook exceeded the model context budget',
      )
    }

    const normalizedMessages = toJsonValue(body.messages) as JsonObject[]
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    const llmCallId = id<CallId>('llm')
    let text = ''
    let reasoning = ''
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined

    const onRequest = async (snapshot: ProviderRequestSnapshot) => {
      await session.logger.write({
        type: 'llm.request',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        scope: 'main',
        normalizedMessages: redactJsonSecrets(snapshot.normalizedMessages, [
          binding.apiKey,
        ]) as JsonValue[],
        providerRequest: redactJsonSecrets(snapshot.providerRequest, [
          binding.apiKey,
        ]),
        requestBytes: snapshot.requestBytes,
        prefixHash: snapshot.prefixHash,
        prefixFingerprints: snapshot.prefixFingerprints,
        promptResources: promptResources(session),
        promptBuild: selection.promptBuild,
        canonicalSource: canonicalTraceSource(selection.messages),
        modelRoute: binding.snapshot,
      })
    }

    for await (const event of provider.stream({
      providerRequest: body,
      normalizedMessages,
      toolDefinitions: compiled.tools,
      signal: run.controller.signal,
      onRequest,
    })) {
      if (event.type === 'text.delta') {
        text += event.delta
        this.#emit(session, {
          type: 'assistant.text.delta',
          sessionId: session.sessionId,
          runId: run.runId,
          delta: event.delta,
        })
      } else if (event.type === 'reasoning.delta') {
        if (binding.snapshot.reasoning !== 'off') {
          reasoning += event.delta
          this.#emit(session, {
            type: 'assistant.reasoning.delta',
            sessionId: session.sessionId,
            runId: run.runId,
            delta: event.delta,
          })
        }
      } else if (event.type === 'completed') {
        completed = event
      }
    }

    if (!completed) throw new Error('Provider stream ended without completion')
    let canonical
    try {
      canonical = adapter.complete(completed, { text, reasoning })
      assertCompletedAssistantTurn(canonical)
      assertAssistantTurnCandidate(session, {
        parts: canonical.parts,
        reasoning: canonical.normalizedReasoningText,
        finishReason: canonical.finishReason,
        route: binding.snapshot,
        continuation: canonical.providerContinuation,
      })
    } catch (error) {
      await session.logger.write({
        type: 'llm.response',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        rawResponse: redactJsonSecrets(completed.rawResponse, [binding.apiKey]),
        normalizedTurn: null,
        providerState: redactJsonSecrets(completed.providerState, [
          binding.apiKey,
        ]),
        usage: completed.usage,
        timing: completed.timing,
      })
      this.#onDiagnostic('Provider completion validation failed', error)
      throw error
    }
    const canonicalText = canonical.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')

    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: llmCallId,
      rawResponse: redactJsonSecrets(completed.rawResponse, [binding.apiKey]),
      normalizedTurn: redactJsonSecrets(toJsonValue(canonical), [
        binding.apiKey,
      ]),
      providerState: redactJsonSecrets(completed.providerState, [
        binding.apiKey,
      ]),
      usage: completed.usage,
      timing: completed.timing,
    })
    const usage = normalizeLlmUsage({
      scope: 'main',
      config,
      provider: binding.provider,
      model: binding.snapshot.model,
      modelProfile: binding.modelProfile,
      raw: completed.usage,
    })
    if (usage) {
      await session.logger.write({
        type: 'llm.usage',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        usage,
      })
      this.#emit(session, {
        type: 'llm.usage',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        usage,
      })
    }
    await this.#pluginBus
      ?.emit('afterLLMCall', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        response: completed.rawResponse,
        usage: completed.usage,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin afterLLMCall failed', error),
      )

    return {
      parts: structuredClone(canonical.parts),
      toolCalls: canonical.toolCalls,
      text: canonicalText,
      reasoning: canonical.normalizedReasoningText ?? reasoning,
      finishReason: canonical.finishReason,
      continuation: canonical.providerContinuation,
    }
  }
}

function assertCompletedAssistantTurn(completed: CompletedAssistantTurn): void {
  const parts = completed.parts.filter(
    (part): part is Extract<MessagePart, { type: 'tool_call' }> =>
      part.type === 'tool_call',
  )
  if (parts.length !== completed.toolCalls.length) {
    throw new TypeError(
      'Provider completion parts do not match normalized tool calls',
    )
  }
  for (const [index, call] of completed.toolCalls.entries()) {
    const part = parts[index]!
    if (
      part.callId !== call.id ||
      part.name !== call.toolId ||
      JSON.stringify(part.arguments) !== JSON.stringify(call.args)
    ) {
      throw new TypeError(
        'Provider completion parts do not match normalized tool calls',
      )
    }
  }
}

/** Creates the configured provider adapter from public settings, credential, and endpoint overrides. */
export function createConfiguredProvider(
  provider: ProviderPublicConfig,
  apiKey: string,
  fetchImpl?: typeof fetch,
  endpoint?: string,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerId: provider.id,
    profile: provider.profile,
    baseURL: provider.baseURL,
    apiKey,
    fetchImpl,
    endpoint,
  })
}
