import type { CallId } from '../../shared/ids'
import type { AssistantActivity } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type {
  MessagePart,
  ProviderContinuationEnvelope,
} from '../../shared/message'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import type { PluginEventBus } from '../plugins/event-bus'
import { createConfiguredProvider } from '../providers/provider-factory'
import {
  assertCompletedAssistantTurn,
  ProviderCompletionError,
  providerCompletionDiagnostics,
  providerRequestDiagnostics,
  type ProviderEvent,
  type ProviderUsage,
  type ProviderResponseDiagnostics,
} from '../providers/provider'
import { normalizeLlmUsage } from '../providers/usage'
import { estimateJsonTokens } from '../tools/context-budget'
import type { ToolCall } from '../tools/types'
import type { ToolRegistry } from '../tools/tool-registry'
import { id, redactJsonSecrets, toJsonValue } from './session-common'
import {
  assertAssistantTurnCandidate,
  canonicalTraceSource,
} from './canonical-history'
import { modelOutputTokenLimit, modelPromptBudget } from './session-run-utils'
import { promptResources, selectPromptMessages } from './prompt-harness'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import type { PromptRegistry } from '../prompts/registry'
import {
  appendAgentsContextIfChanged,
  appendRuntimeContextIfChanged,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'
import { resolveSessionToolCatalog } from './session-tool-catalog'
import type { OperationalLogService } from '../operational-logging/service'
import { ProviderAttemptRecorder } from '../operational-logging/provider-attempt-recorder'
import {
  recordProviderAttemptFailure,
  writeProviderFailureTrace,
} from './provider-failure-diagnostics'

export interface ProviderTurnResult {
  parts: MessagePart[]
  toolCalls: ToolCall[]
  text: string
  reasoning: string
  finishReason: string
  continuation?: ProviderContinuationEnvelope
  usage: ProviderUsage
}

/** Runs provider-turn lifecycle, plugin hooks, streaming provider calls, and tool validation. */
export class SessionProviderTurnRunner {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #pluginBus: PluginEventBus | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #onDiagnostic: DiagnosticSink
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #getWorkspaceConcurrency: (
    session: SessionState,
  ) => WorkspaceConcurrencyContext
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    pluginBus?: PluginEventBus
    promptRegistry?: PromptRegistry
    fetchImpl?: typeof fetch
    providerFactory: SessionManagerOptions['providerFactory']
    onDiagnostic: DiagnosticSink
    operationalLog?: Pick<OperationalLogService, 'log'>
    emit: (session: SessionState, event: AgentEventDraft) => void
    getWorkspaceConcurrency?: (
      session: SessionState,
    ) => WorkspaceConcurrencyContext
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#pluginBus = options.pluginBus
    this.#promptRegistry = options.promptRegistry
    this.#fetchImpl = options.fetchImpl
    this.#providerFactory = options.providerFactory
    this.#onDiagnostic = options.onDiagnostic
    this.#operationalLog = options.operationalLog
    this.#emit = options.emit
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
  }

  async #writeFailure(
    session: SessionState,
    run: ActiveRun,
    callId: CallId,
    apiKey: string,
    error: unknown,
    diagnostics?: ProviderResponseDiagnostics,
    classification?: { stage: string; code: string },
  ): Promise<void> {
    await writeProviderFailureTrace({
      logger: session.logger,
      sessionId: session.sessionId,
      runId: run.runId,
      callId,
      ...(session.internalExecution
        ? { agentExecutionId: session.internalExecution.executionId }
        : {}),
      apiKey,
      operation: 'main',
      error,
      ...(diagnostics ? { diagnostics } : {}),
      ...(classification ? { classification } : {}),
    })
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
    const toolCatalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      swarmMaxAgents: run.swarmToolConfig?.maxAgentsPerJob,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    const tools = toolCatalog.definitions

    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: binding.snapshot.providerId,
      promptRegistry: this.#promptRegistry,
      reason: 'provider_call',
      workspaceConcurrency: this.#getWorkspaceConcurrency(session),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    })
    await appendAgentsContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: binding.snapshot.providerId,
      promptRegistry: this.#promptRegistry,
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    })

    const selection = selectPromptMessages({
      state: session,
      tools,
      maxPromptTokens: modelPromptBudget(binding.modelProfile),
      estimation: config.limits.tokenEstimation,
    })
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    const compiled = provider.compile({
      history: {
        sessionId: session.sessionId,
        messages: selection.messages,
        sourceHash: selection.promptBuild.sourceHash,
      },
      route: binding.snapshot,
      tools,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
    selection.promptBuild.estimatedTokens = estimateJsonTokens(
      compiled.request,
      config.limits.tokenEstimation,
    )
    if (session.visibility === 'public') {
      await this.#pluginBus
        ?.emit('beforeLLMCall', {
          version: 3,
          sessionId: session.sessionId,
          runId: run.runId,
          providerType: provider.providerType,
          route: binding.snapshot,
          request: structuredClone(compiled.request),
        })
        .catch((error: unknown) =>
          this.#onDiagnostic('Plugin beforeLLMCall failed', error),
        )
    }

    const llmCallId = id<CallId>('llm')
    let reasoning = ''
    let streamActivity: AssistantActivity | undefined
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined
    const emitActivity = (activity: AssistantActivity): void => {
      if (streamActivity === activity) return
      streamActivity = activity
      this.#emit(session, {
        type: 'assistant.activity',
        sessionId: session.sessionId,
        runId: run.runId,
        activity,
      })
    }
    const diagnostics = providerRequestDiagnostics(compiled)
    const attempt = new ProviderAttemptRecorder(this.#operationalLog, {
      operation: 'main',
      sessionId: session.sessionId,
      runId: run.runId,
      providerCallId: llmCallId,
      ...(session.internalExecution
        ? { agentExecutionId: session.internalExecution.executionId }
        : {}),
      ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
      providerId: binding.snapshot.providerId,
      providerType: provider.providerType,
      model: binding.snapshot.model,
      reasoning: binding.snapshot.reasoning,
      endpoint: binding.snapshot.endpoint,
      messageCount: compiled.normalizedMessages.length,
      toolCount: compiled.tools.length,
      requestBytes: diagnostics.requestBytes,
    })
    await session.logger.write({
      type: 'llm.request',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: llmCallId,
      scope: 'main',
      normalizedMessages: redactJsonSecrets(compiled.normalizedMessages, [
        binding.apiKey,
      ]) as JsonValue[],
      providerRequest: redactJsonSecrets(compiled.request, [binding.apiKey]),
      requestBytes: diagnostics.requestBytes,
      prefixHash: diagnostics.prefixHash,
      promptResources: promptResources(session),
      promptBuild: selection.promptBuild,
      canonicalSource: canonicalTraceSource(selection.messages),
      modelRoute: binding.snapshot,
    })

    try {
      for await (const event of provider.stream(compiled, {
        signal: run.controller.signal,
      })) {
        if (event.type === 'text.delta') {
          emitActivity('output')
          this.#emit(session, {
            type: 'assistant.text.delta',
            sessionId: session.sessionId,
            runId: run.runId,
            delta: event.delta,
          })
        } else if (event.type === 'reasoning.delta') {
          if (binding.snapshot.reasoning !== 'off') {
            emitActivity('reasoning')
            reasoning += event.delta
            this.#emit(session, {
              type: 'assistant.reasoning.delta',
              sessionId: session.sessionId,
              runId: run.runId,
              delta: event.delta,
            })
          }
        } else if (event.type === 'tool.delta') {
          emitActivity('tool_call')
        } else if (event.type === 'completed') {
          if (completed) {
            throw new Error('Provider stream produced multiple completions')
          }
          completed = event
        }
      }
    } catch (error) {
      if (run.controller.signal.aborted) {
        attempt.completed({ outcome: 'cancelled' })
        throw error
      }
      const failure =
        error instanceof ProviderCompletionError
          ? error.diagnostics
          : completed
            ? providerCompletionDiagnostics(completed)
            : undefined
      if (failure) {
        recordProviderAttemptFailure(attempt, error, failure)
        await this.#writeFailure(
          session,
          run,
          llmCallId,
          binding.apiKey,
          error,
          failure,
        )
        this.#onDiagnostic('Provider completion failed', error, {
          audience: 'internal',
        })
      }
      if (!failure) {
        recordProviderAttemptFailure(attempt, error)
        await this.#writeFailure(session, run, llmCallId, binding.apiKey, error)
      }
      throw error
    }

    if (!completed) {
      const error = new Error('Provider stream ended without completion')
      recordProviderAttemptFailure(attempt, error)
      await this.#writeFailure(session, run, llmCallId, binding.apiKey, error)
      throw error
    }
    const canonical = completed.turn
    try {
      assertCompletedAssistantTurn(canonical)
      assertAssistantTurnCandidate(session, {
        parts: canonical.parts,
        reasoning: canonical.normalizedReasoningText,
        finishReason: canonical.finishReason,
        route: binding.snapshot,
        continuation: canonical.providerContinuation,
      })
    } catch (error) {
      recordProviderAttemptFailure(
        attempt,
        error,
        providerCompletionDiagnostics(completed),
        'PROVIDER_COMPLETION_INVALID',
      )
      await this.#writeFailure(
        session,
        run,
        llmCallId,
        binding.apiKey,
        error,
        providerCompletionDiagnostics(completed),
        { stage: 'validation', code: 'PROVIDER_COMPLETION_INVALID' },
      )
      this.#onDiagnostic('Provider completion validation failed', error, {
        audience: 'internal',
      })
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
      usage: canonical.usage.raw,
      timing: toJsonValue(completed.timing),
    })
    attempt.completed({
      durationMs: completed.timing.totalMs,
      ttftMs: completed.timing.ttftMs,
      responseBytes: completed.timing.responseBytes,
      usage: canonical.usage,
    })
    const usage = normalizeLlmUsage({
      scope: 'main',
      config,
      provider: binding.provider,
      model: binding.snapshot.model,
      modelProfile: binding.modelProfile,
      usage: canonical.usage,
    })
    if (usage) {
      run.usageRecords.push(structuredClone(usage))
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
    if (session.visibility === 'public') {
      await this.#pluginBus
        ?.emit('afterLLMCall', {
          version: 1,
          sessionId: session.sessionId,
          runId: run.runId,
          response: completed.rawResponse,
          usage: canonical.usage.raw,
        })
        .catch((error: unknown) =>
          this.#onDiagnostic('Plugin afterLLMCall failed', error),
        )
    }

    return {
      parts: structuredClone(canonical.parts),
      toolCalls: canonical.toolCalls,
      text: canonicalText,
      reasoning: canonical.normalizedReasoningText ?? reasoning,
      finishReason: canonical.finishReason,
      continuation: canonical.providerContinuation,
      usage: structuredClone(canonical.usage),
    }
  }
}
