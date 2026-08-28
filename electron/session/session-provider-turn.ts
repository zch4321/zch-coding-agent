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
import { resolveSessionToolCatalog } from './session-tool-catalog'
import type { OperationalLogService } from '../operational-logging/service'
import {
  ProviderAttemptRecorder,
  requestDiagnosticFields,
} from '../operational-logging/provider-attempt-recorder'
import {
  recordProviderAttemptFailure,
  writeProviderFailureTrace,
} from './provider-failure-diagnostics'
import {
  createProviderTurnRetryBudget,
  MAX_PROVIDER_TURN_ATTEMPTS,
  ProviderStreamIncompleteError,
  providerTurnRetryDecision,
  waitForProviderTurnRetry,
} from './session-provider-retry'

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
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #onDiagnostic: DiagnosticSink
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    pluginBus?: PluginEventBus
    fetchImpl?: typeof fetch
    providerFactory: SessionManagerOptions['providerFactory']
    onDiagnostic: DiagnosticSink
    operationalLog?: Pick<OperationalLogService, 'log'>
    emit: (session: SessionState, event: AgentEventDraft) => void
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#pluginBus = options.pluginBus
    this.#fetchImpl = options.fetchImpl
    this.#providerFactory = options.providerFactory
    this.#onDiagnostic = options.onDiagnostic
    this.#operationalLog = options.operationalLog
    this.#emit = options.emit
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
      swarmEnabled: Boolean(run.swarmToolConfig),
      maxSubagents: run.maxSubagents,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    const tools = toolCatalog.definitions

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

    const diagnostics = providerRequestDiagnostics(compiled)
    const retryBudget = createProviderTurnRetryBudget()
    for (
      let attemptNumber = 1;
      attemptNumber <= MAX_PROVIDER_TURN_ATTEMPTS;
      attemptNumber += 1
    ) {
      const llmCallId = id<CallId>('llm')
      let reasoning = ''
      let streamActivity: AssistantActivity | undefined
      let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined
      let accepted: Extract<ProviderEvent, { type: 'completed' }> | undefined
      let failureClassification: { stage: string; code: string } | undefined
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
        ...requestDiagnosticFields(diagnostics),
        attempt: attemptNumber,
        maxAttempts: MAX_PROVIDER_TURN_ATTEMPTS,
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
        requestFields: diagnostics.requestFields,
        wireParameters: redactJsonSecrets(diagnostics.wireParameters, [
          binding.apiKey,
        ]),
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
              throw new TypeError(
                'Provider stream produced multiple completions',
              )
            }
            completed = event
          }
        }
        if (!completed) throw new ProviderStreamIncompleteError()
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
          failureClassification = {
            stage: 'validation',
            code: 'PROVIDER_COMPLETION_INVALID',
          }
          throw error
        }
        accepted = completed
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
        recordProviderAttemptFailure(
          attempt,
          error,
          failure,
          failureClassification?.code,
        )
        await this.#writeFailure(
          session,
          run,
          llmCallId,
          binding.apiKey,
          error,
          failure,
          failureClassification,
        )
        if (failureClassification) {
          this.#onDiagnostic('Provider completion validation failed', error, {
            audience: 'internal',
          })
        } else if (failure) {
          this.#onDiagnostic('Provider completion failed', error, {
            audience: 'internal',
          })
        }
        const retry =
          attemptNumber < MAX_PROVIDER_TURN_ATTEMPTS
            ? providerTurnRetryDecision(error, retryBudget)
            : undefined
        if (!retry) throw error
        this.#emit(session, {
          type: 'assistant.stream.reset',
          sessionId: session.sessionId,
          runId: run.runId,
        })
        this.#emit(session, {
          type: 'provider.retrying',
          sessionId: session.sessionId,
          runId: run.runId,
          retry: {
            attempt: attemptNumber + 1,
            maxAttempts: MAX_PROVIDER_TURN_ATTEMPTS,
            delayMs: retry.delayMs,
          },
        })
        await waitForProviderTurnRetry(retry.delayMs, run.controller.signal)
        continue
      }

      if (!accepted) {
        throw new Error('Provider retry loop accepted no completion')
      }
      const canonical = accepted.turn
      const canonicalText = canonical.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')

      await session.logger.write({
        type: 'llm.response',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        rawResponse: redactJsonSecrets(accepted.rawResponse, [binding.apiKey]),
        normalizedTurn: redactJsonSecrets(toJsonValue(canonical), [
          binding.apiKey,
        ]),
        providerState: redactJsonSecrets(accepted.providerState, [
          binding.apiKey,
        ]),
        usage: canonical.usage.raw,
        timing: toJsonValue(accepted.timing),
      })
      attempt.completed({
        durationMs: accepted.timing.totalMs,
        ttftMs: accepted.timing.ttftMs,
        responseBytes: accepted.timing.responseBytes,
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
            response: accepted.rawResponse,
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
    throw new Error('Provider retry loop ended unexpectedly')
  }
}
