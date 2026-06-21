import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ToolCall } from '../tools/types'
import {
  ContextBudgetError,
  estimateJsonTokens,
  selectContextMessages,
} from './context-budget'
import { DeepSeekProvider } from './deepseek-provider'
import type {
  ProviderAssistantTurn,
  ProviderEvent,
  ProviderMessage,
  ProviderRequestSnapshot,
} from './provider'
import type { SkillsManager } from '../skills/manager'
import type { ToolRegistry } from './tool-registry'
import { id, ipcFault, toJsonValue } from './session-common'
import { contextMessages, modelPromptBudget } from './session-run-utils'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import type { CallId } from '../../shared/ids'

export interface ProviderTurnResult {
  turn: ProviderAssistantTurn
  toolCalls: ToolCall[]
  text: string
  reasoning: string
}

export class SessionProviderTurnRunner {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #pluginBus: PluginEventBus | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    pluginBus?: PluginEventBus
    providerFactory: SessionManagerOptions['providerFactory']
    onDiagnostic: (message: string, error?: unknown) => void
    emit: (session: SessionState, event: AgentEventDraft) => void
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#pluginBus = options.pluginBus
    this.#providerFactory = options.providerFactory
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
  }

  async callProvider(
    session: SessionState,
    run: ActiveRun,
    setRunCalling: () => void,
  ): Promise<ProviderTurnResult> {
    setRunCalling()
    const config = this.#configStore.getPublicConfig()
    const apiKey = await this.#configStore.getDeepSeekApiKey()

    if (!apiKey) {
      ipcFault('PRECONDITION_FAILED', 'DeepSeek credential is not available')
    }

    const tools = this.#toolRegistry.providerDefinitions()
    let messages = session.systemPromptOverride
      ? selectContextMessages({
          system: { role: 'system', content: session.systemPromptOverride },
          history: session.history,
          maxPromptTokens: modelPromptBudget(config, tools),
          estimation: config.limits.tokenEstimation,
        })
      : contextMessages(
          session.history,
          config,
          tools,
          this.#skillsManager?.summaryPrompt() ?? '',
        )
    const hookResult = await this.#pluginBus?.emit('beforeLLMCall', {
      version: 1,
      sessionId: session.sessionId,
      runId: run.runId,
      messages: toJsonValue(messages) as JsonValue[],
      params: {
        provider: 'deepseek',
        model: config.providers.deepseek.model,
      },
    })

    for (const patch of hookResult?.patches ?? []) {
      if (patch.messages) {
        messages = patch.messages as unknown as ProviderMessage[]
      }
    }

    if (
      estimateJsonTokens(messages, config.limits.tokenEstimation) >
      modelPromptBudget(config, tools)
    ) {
      throw new ContextBudgetError(
        'A beforeLLMCall hook exceeded the model context budget',
      )
    }

    const provider =
      this.#providerFactory?.({ config, apiKey }) ??
      new DeepSeekProvider({
        baseURL: config.providers.deepseek.baseURL,
        model: config.providers.deepseek.model,
        reasoning: config.providers.deepseek.reasoning,
        apiKey,
      })
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
        normalizedMessages: snapshot.normalizedMessages,
        providerRequest: snapshot.providerRequest,
        requestBytes: snapshot.requestBytes,
        prefixHash: snapshot.prefixHash,
        prefixFingerprints: snapshot.prefixFingerprints,
      })
    }

    const providerRequestOverride = session.providerRequestOverride
    session.providerRequestOverride = undefined

    for await (const event of provider.streamChat({
      messages,
      tools,
      providerRequestOverride,
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
        if (config.providers.deepseek.reasoning !== 'off') {
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

    if (!completed) {
      throw new Error('Provider stream ended without completion')
    }

    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: llmCallId,
      rawResponse: completed.rawResponse,
      normalizedTurn: toJsonValue(completed.turn),
      providerState: completed.providerState,
      usage: completed.usage,
      timing: completed.timing,
    })
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
      turn: completed.turn,
      toolCalls: completed.toolCalls,
      text,
      reasoning,
    }
  }
}
