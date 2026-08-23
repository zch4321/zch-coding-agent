import type { RunStatus } from '../../shared/agent-events'
import type { CallId, MessageId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ProviderUsage } from '../providers/provider'
import {
  areModelRoutesHistoryCompatible,
  type ModelRouteSnapshot,
} from '../../shared/model-route'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import {
  ProviderCompletionError,
  ProviderCompactUnsupportedError,
  providerRequestDiagnostics,
  type CompletedProviderCompact,
  type ProviderCompactEvent,
  type ProviderCompactMode,
  type ProviderResponseDiagnostics,
} from '../providers/provider'
import { createConfiguredProvider } from '../providers/provider-factory'
import { normalizeLlmUsage } from '../providers/usage'
import type { SkillsManager } from '../skills/manager'
import type { ToolRegistry } from '../tools/tool-registry'
import { id, redactJsonSecrets, toJsonValue } from './session-common'
import { modelOutputTokenLimit } from './session-run-utils'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionHistorySourcePort,
  SessionManagerOptions,
  SessionState,
  SessionExecutionStatePort,
} from './session-types'
import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import {
  appendInitialPromptHarness,
  orchestrationRequestContent,
  promptResources,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'
import {
  appendControlCommand,
  appendConversationTranscript,
  appendPromptMessage,
  appendProviderCompactSummary,
  appendUserInput,
  canonicalHash,
  canonicalTraceSource,
  deactivateActiveHistory,
  MessageHistoryCompiler,
} from './canonical-history'
import {
  conversationTranscriptContent,
  renderConversationTranscript,
} from './conversation-transcript'
import {
  compactRetryDecision,
  correctiveCompactPrompt,
  createCompactRetryBudget,
  MAX_COMPACT_ATTEMPTS,
  rethrowCompactionFailure,
  shouldFallbackNativeCompact,
  waitForCompactRetry,
} from './session-compact-retry'
import { resolveSessionToolCatalog } from './session-tool-catalog'
import type { OperationalLogService } from '../operational-logging/service'
import {
  ProviderAttemptRecorder,
  requestDiagnosticFields,
} from '../operational-logging/provider-attempt-recorder'
import {
  associateDiagnosticId,
  diagnosticIdForError,
} from '../operational-logging/diagnostic-id'
import {
  recordProviderAttemptFailure,
  writeProviderFailureTrace,
} from './provider-failure-diagnostics'

function compactOrchestrationState(input: {
  goal?: GoalState
  plan?: PlanState
}): string {
  return [
    'Orchestration state at compaction:',
    `Goal: ${input.goal ? JSON.stringify(input.goal) : 'none'}`,
    `Plan: ${input.plan ? JSON.stringify(input.plan) : 'none'}`,
  ].join('\n')
}

function appendOrchestrationStateCheckpoint(
  session: SessionState,
  run: ActiveRun,
): void {
  appendPromptMessage(session, {
    kind: 'runtime_context',
    content: orchestrationRequestContent(
      'compact-state',
      compactOrchestrationState(session),
    ),
    source: 'runtime:compaction-orchestration-state',
    trusted: true,
    editable: false,
    turnId: run.rootUserMessageId,
  })
}

function compactFollowUp(message: string): string | undefined {
  const match = /^\s*\/compact(?:\s+([\s\S]*?))?\s*$/iu.exec(message)
  const followUp = match?.[1]?.trim()
  return followUp || undefined
}

function authoritativeContextTokens(usage: ProviderUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens
  if (
    usage.promptTokens !== undefined &&
    usage.completionTokens !== undefined
  ) {
    return usage.promptTokens + usage.completionTokens
  }
  return undefined
}

function nativeCompactCapabilityKey(route: ModelRouteSnapshot): string {
  return JSON.stringify([
    route.providerType,
    route.providerId,
    route.endpoint,
    route.model,
    route.providerConfigRevision,
  ])
}

function durableUsage(usage: ProviderUsage) {
  const normalized = {
    ...(usage.promptTokens === undefined
      ? {}
      : { inputTokens: usage.promptTokens }),
    ...(usage.completionTokens === undefined
      ? {}
      : { outputTokens: usage.completionTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cacheHitTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cacheHitTokens }),
    ...(usage.cacheMissTokens === undefined
      ? {}
      : { cacheMissTokens: usage.cacheMissTokens }),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/** Coordinates Provider-anchored compaction and portable history transitions. */
export class SessionCompactCoordinator {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #setRunStatus: (
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ) => void
  readonly #getWorkspaceConcurrency: (
    session: SessionState,
  ) => WorkspaceConcurrencyContext
  readonly #executionState?: SessionExecutionStatePort
  readonly #historySource?: SessionHistorySourcePort
  readonly #unsupportedNativeCompaction = new Set<string>()
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    providerFactory: SessionManagerOptions['providerFactory']
    fetchImpl: SessionManagerOptions['fetchImpl']
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
    setRunStatus: (
      session: SessionState,
      run: ActiveRun,
      status: RunStatus,
      error?: unknown,
    ) => void
    getWorkspaceConcurrency?: (
      session: SessionState,
    ) => WorkspaceConcurrencyContext
    executionState?: SessionExecutionStatePort
    historySource?: SessionHistorySourcePort
    operationalLog?: Pick<OperationalLogService, 'log'>
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
    this.#executionState = options.executionState
    this.#historySource = options.historySource
    this.#operationalLog = options.operationalLog
  }

  /** Migrates incompatible Provider history and handles deferred final-turn compaction. */
  async prepareBeforeRunInput(
    session: SessionState,
    run: ActiveRun,
    options: { compactCommand: boolean },
  ): Promise<void> {
    const transitioned = await this.#transitionHistoryIfNeeded(session, run)
    if (transitioned || options.compactCommand) return
    const usage = this.#latestActiveAssistantUsage(session)
    if (!usage || this.assessProviderUsage(run, usage) !== 'compact') return
    await this.#compactActiveHistory(session, run, {
      emitText: false,
      replayReason: 'deferred-final-turn',
    })
  }

  /** Evaluates only Provider-supplied usage against the frozen model profile. */
  assessProviderUsage(
    run: ActiveRun,
    usage: ProviderUsage,
  ): 'none' | 'compact' {
    const profile = run.routes?.main.modelProfile
    if (!profile) throw new Error('Run model routes were not resolved')
    const contextTokens = authoritativeContextTokens(usage)
    if (contextTokens === undefined) return 'none'
    return contextTokens >= profile.compactThresholdTokens ? 'compact' : 'none'
  }

  /** Compacts a complete tool batch before the next Provider continuation. */
  async compactAfterToolBatch(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    await this.#compactActiveHistory(session, run, {
      emitText: false,
      replayReason: 'tool-batch',
    })
  }

  /** Compacts before an application-directed continuation with no tool batch. */
  async compactBeforeContinuation(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    await this.#compactActiveHistory(session, run, {
      emitText: false,
      replayReason: 'orchestration-continuation',
    })
  }

  /** Executes `/compact`, optionally deriving a new user request after the checkpoint. */
  async runCompactCommand(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
  ): Promise<boolean> {
    try {
      return await this.#runCompactCommand(session, run, userMessage)
    } catch (error) {
      this.#recordCompactionFailure(session, run, error)
      rethrowCompactionFailure(error, run.controller.signal)
    }
  }

  async #runCompactCommand(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
  ): Promise<boolean> {
    const source = new MessageHistoryCompiler().compile(session.history)
    const prompt = this.#orchestratorMessages.prompt('compact')
    const beforeCommandHistory = structuredClone(session.history)
    const beforeCommandNextSeq = session.nextMessageSeq
    let commandRecord:
      | Extract<SessionState['history'][number], { kind: 'user_input' }>
      | undefined
    const compact = await this.#performCompact(session, run, {
      promptText: [prompt.text, '', compactOrchestrationState(session)].join(
        '\n',
      ),
      sourceMessages: source.messages,
      emitText: true,
      beforeProvider: async () => {
        commandRecord = appendControlCommand(session, {
          content: userMessage,
          clientRequestId: run.clientRequestId,
          requestHash: canonicalHash(userMessage),
          command: 'compact',
        })
        try {
          await this.#executionState?.commit(session, {
            reason: 'command_input',
          })
          run.requestCommitted = true
        } catch (error) {
          session.history = beforeCommandHistory
          session.nextMessageSeq = beforeCommandNextSeq
          throw error
        }
        await this.#orchestratorMessages.emit(session, run, {
          kind: 'compact',
          text: prompt.text,
          resource: prompt.resource,
          injectIntoHistory: false,
        })
      },
    })
    if (!commandRecord) {
      throw new Error('Compact command was not journaled before Provider use')
    }
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    const previousRootUserMessageId = run.rootUserMessageId
    try {
      const followUp = compactFollowUp(userMessage)
      const derived = await this.#rewriteCompact(session, run, {
        compact,
        sourceHash: source.sourceHash,
        replacesThroughSeq: source.messages.at(-1)!.seq,
        resource: prompt.resource,
        commit: false,
        ...(followUp
          ? {
              derivedPayload: {
                content: followUp,
                sourceMessageId: commandRecord.id,
              },
            }
          : {}),
      })
      if (followUp) {
        if (!derived)
          throw new Error('Compact follow-up payload was not rebuilt')
        run.rootUserMessageId = derived
        await session.logger.write({
          type: 'user.message',
          sessionId: session.sessionId,
          runId: run.runId,
          text: followUp,
        })
      }
      await this.#executionState?.commit(session, {
        reason: 'compact',
        deactivateThroughSeq: source.messages.at(-1)!.seq,
        invalidate: true,
      })
      if (followUp) return true
    } catch (error) {
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      run.rootUserMessageId = previousRootUserMessageId
      throw error
    }

    if (compact.normalizedText) {
      this.#emit(session, {
        type: 'assistant.message.completed',
        sessionId: session.sessionId,
        runId: run.runId,
        text: compact.normalizedText,
      })
      await session.logger.write({
        type: 'agent.message',
        sessionId: session.sessionId,
        runId: run.runId,
        text: redactJsonSecrets(compact.normalizedText, [
          run.routes!.compression.apiKey,
        ]) as string,
      })
    }
    return false
  }

  async #compactActiveHistory(
    session: SessionState,
    run: ActiveRun,
    input: { emitText: boolean; replayReason: string },
  ): Promise<void> {
    try {
      await this.#compactActiveHistoryOperation(session, run, input)
    } catch (error) {
      this.#recordCompactionFailure(session, run, error)
      rethrowCompactionFailure(error, run.controller.signal)
    }
  }

  async #compactActiveHistoryOperation(
    session: SessionState,
    run: ActiveRun,
    input: { emitText: boolean; replayReason: string },
  ): Promise<void> {
    const source = new MessageHistoryCompiler().compile(session.history)
    const prompt = this.#orchestratorMessages.prompt('compact')
    const promptText = [
      prompt.text,
      '',
      'Compact the complete active history as a continuation checkpoint.',
      'Preserve completed work, tool evidence, pending state, and user intent.',
      compactOrchestrationState(session),
    ].join('\n')
    await this.#orchestratorMessages.emit(session, run, {
      kind: 'compact-auto',
      text: promptText,
      resource: prompt.resource,
      injectIntoHistory: false,
    })
    const compact = await this.#performCompact(session, run, {
      promptText,
      sourceMessages: source.messages,
      emitText: input.emitText,
    })
    await this.#rewriteCompact(session, run, {
      compact,
      sourceHash: source.sourceHash,
      replacesThroughSeq: source.messages.at(-1)!.seq,
      resource: prompt.resource,
      commit: true,
    })
  }

  async #performCompact(
    session: SessionState,
    run: ActiveRun,
    input: {
      promptText: string
      sourceMessages: readonly SessionState['history'][number][]
      emitText: boolean
      beforeProvider?: () => Promise<void>
    },
  ): Promise<CompletedProviderCompact> {
    try {
      return await this.#performCompactWithRetry(session, run, input)
    } catch (error) {
      rethrowCompactionFailure(error, run.controller.signal)
    }
  }

  async #performCompactWithRetry(
    session: SessionState,
    run: ActiveRun,
    input: {
      promptText: string
      sourceMessages: readonly SessionState['history'][number][]
      emitText: boolean
      beforeProvider?: () => Promise<void>
    },
  ): Promise<CompletedProviderCompact> {
    const binding = run.routes?.compression
    if (!binding) throw new Error('Compression route was not resolved')
    const config = this.#configStore.getPublicConfig()
    const history = new MessageHistoryCompiler().compile(input.sourceMessages)
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    const latestUsage = this.#latestActiveAssistantUsage(session)
    const contextTokens = latestUsage
      ? authoritativeContextTokens(latestUsage)
      : undefined
    const compactInput = (instructions: string) => ({
      history,
      route: binding.snapshot,
      instructions,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    })
    const availableModes = [
      ...provider.compactModes(compactInput(input.promptText)),
    ]
    if (
      availableModes.length === 0 ||
      availableModes.some((mode) => mode !== 'native' && mode !== 'synthetic')
    ) {
      throw new TypeError('Provider returned invalid compact modes')
    }
    const capabilityKey = nativeCompactCapabilityKey(binding.snapshot)
    let mode: ProviderCompactMode =
      availableModes.includes('native') &&
      !this.#unsupportedNativeCompaction.has(capabilityKey)
        ? 'native'
        : availableModes.includes('synthetic')
          ? 'synthetic'
          : availableModes[0]!
    const compile = (
      instructions: string,
      compactMode: ProviderCompactMode,
    ) => {
      const candidate = provider.compileCompact(
        compactInput(instructions),
        compactMode,
      )
      if (candidate.mode !== compactMode) {
        throw new TypeError('Provider compiled a different compact mode')
      }
      return candidate
    }
    let instructions = input.promptText
    let compiled = compile(instructions, mode)
    await input.beforeProvider?.()
    let retryBudget = createCompactRetryBudget()
    let attempt = 1

    while (attempt <= MAX_COMPACT_ATTEMPTS) {
      const callId = id<CallId>('llm')
      let completed:
        | Extract<ProviderCompactEvent, { type: 'completed' }>
        | undefined
      const textDeltas: string[] = []
      this.#setRunStatus(session, run, 'calling_llm')
      const diagnostics = providerRequestDiagnostics(compiled)
      const attemptRecorder = new ProviderAttemptRecorder(
        this.#operationalLog,
        {
          operation: 'compact',
          sessionId: session.sessionId,
          runId: run.runId,
          providerCallId: callId,
          ...(session.internalExecution
            ? { agentExecutionId: session.internalExecution.executionId }
            : {}),
          ...(session.logger.traceId
            ? { traceId: session.logger.traceId }
            : {}),
          providerId: binding.snapshot.providerId,
          providerType: provider.providerType,
          model: binding.snapshot.model,
          reasoning: binding.snapshot.reasoning,
          endpoint: binding.snapshot.endpoint,
          messageCount: compiled.normalizedMessages.length,
          toolCount: 0,
          ...requestDiagnosticFields(diagnostics),
        },
      )
      await session.logger.write({
        type: 'llm.request',
        sessionId: session.sessionId,
        runId: run.runId,
        callId,
        scope: 'compression',
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
        canonicalSource: canonicalTraceSource(history.messages),
        modelRoute: binding.snapshot,
      })
      try {
        for await (const event of provider.compact(compiled, {
          signal: run.controller.signal,
        })) {
          if (event.type === 'text.delta') {
            textDeltas.push(event.delta)
          } else if (completed) {
            throw new TypeError(
              'Compact provider produced multiple completions',
            )
          } else {
            completed = event
          }
        }
        if (!completed) {
          throw new TypeError(
            'Compact provider stream ended without completion',
          )
        }
      } catch (error) {
        if (run.controller.signal.aborted) {
          attemptRecorder.completed({ outcome: 'cancelled' })
          throw error
        }
        const responseDiagnostics =
          error instanceof ProviderCompletionError ||
          error instanceof ProviderCompactUnsupportedError
            ? error.diagnostics
            : undefined
        const nativeFallback =
          mode === 'native' &&
          availableModes.includes('synthetic') &&
          shouldFallbackNativeCompact(error)
        if (nativeFallback) {
          attemptRecorder.fallback('NATIVE_COMPACT_UNAVAILABLE', error)
        } else {
          recordProviderAttemptFailure(
            attemptRecorder,
            error,
            responseDiagnostics,
          )
        }
        await this.#writeFailure(
          session,
          run,
          callId,
          binding.apiKey,
          error,
          responseDiagnostics,
        )
        if (nativeFallback) {
          this.#unsupportedNativeCompaction.add(capabilityKey)
          mode = 'synthetic'
          instructions = input.promptText
          retryBudget = createCompactRetryBudget()
          compiled = compile(instructions, mode)
          attempt = 1
          continue
        }
        const retry =
          attempt < MAX_COMPACT_ATTEMPTS
            ? compactRetryDecision(error, retryBudget)
            : undefined
        if (!retry) throw error
        await waitForCompactRetry(retry.delayMs, run.controller.signal)
        if (retry.corrective) {
          instructions = correctiveCompactPrompt(input.promptText)
        }
        compiled = compile(instructions, mode)
        attempt += 1
        continue
      }
      await session.logger.write({
        type: 'llm.response',
        sessionId: session.sessionId,
        runId: run.runId,
        callId,
        rawResponse: redactJsonSecrets(completed.rawResponse, [binding.apiKey]),
        normalizedTurn: redactJsonSecrets(toJsonValue(completed.compact), [
          binding.apiKey,
        ]),
        providerState: redactJsonSecrets(completed.providerState, [
          binding.apiKey,
        ]),
        usage: completed.compact.usage.raw,
        timing: toJsonValue(completed.timing),
      })
      attemptRecorder.completed({
        durationMs: completed.timing.totalMs,
        ttftMs: completed.timing.ttftMs,
        responseBytes: completed.timing.responseBytes,
        usage: completed.compact.usage,
      })
      const usage = normalizeLlmUsage({
        scope: 'compression',
        config,
        provider: binding.provider,
        model: binding.snapshot.model,
        modelProfile: binding.modelProfile,
        usage: completed.compact.usage,
      })
      if (usage) {
        run.usageRecords.push(structuredClone(usage))
        await session.logger.write({
          type: 'llm.usage',
          sessionId: session.sessionId,
          runId: run.runId,
          callId,
          usage,
        })
        this.#emit(session, {
          type: 'llm.usage',
          sessionId: session.sessionId,
          runId: run.runId,
          callId,
          usage,
        })
      }
      if (input.emitText) {
        for (const delta of textDeltas) {
          this.#emit(session, {
            type: 'assistant.text.delta',
            sessionId: session.sessionId,
            runId: run.runId,
            delta,
          })
        }
      }
      return structuredClone(completed.compact)
    }
    throw new Error('Compact retry loop ended unexpectedly')
  }

  async #rewriteCompact(
    session: SessionState,
    run: ActiveRun,
    input: {
      compact: CompletedProviderCompact
      sourceHash: string
      replacesThroughSeq: number
      resource?: ReturnType<SessionOrchestratorMessages['prompt']>['resource']
      commit: boolean
      derivedPayload?: { content: string; sourceMessageId: MessageId }
    },
  ): Promise<MessageId | undefined> {
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    try {
      deactivateActiveHistory(session)
      await this.#appendFreshHarness(session, run)
      appendOrchestrationStateCheckpoint(session, run)
      appendProviderCompactSummary(session, {
        payload: input.compact.payload,
        route: run.routes!.compression.snapshot,
        replacesThroughSeq: input.replacesThroughSeq,
        sourceHash: input.sourceHash,
        usage: durableUsage(input.compact.usage),
        resource: input.resource,
        turnId: run.rootUserMessageId,
      })
      const derived = input.derivedPayload
        ? appendUserInput(session, {
            content: input.derivedPayload.content,
            derivedFromMessageId: input.derivedPayload.sourceMessageId,
          })
        : undefined
      await this.#validateActiveHistoryCompilation(session, run)
      if (input.commit) {
        await this.#executionState?.commit(session, {
          reason: 'compact',
          deactivateThroughSeq: input.replacesThroughSeq,
          invalidate: true,
        })
      }
      return derived?.id
    } catch (error) {
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      throw error
    }
  }

  async #transitionHistoryIfNeeded(
    session: SessionState,
    run: ActiveRun,
  ): Promise<boolean> {
    const target = run.routes?.main.snapshot
    if (!target) throw new Error('Run model routes were not resolved')
    const active = session.history.filter(
      (record) => record.inHistory && record.visibility !== 'superseded',
    )
    const hasDirectMismatch = active.some(
      (record) =>
        (record.kind === 'assistant_turn' ||
          record.kind === 'conversation_transcript' ||
          (record.kind === 'compact_summary' && 'modelRoute' in record)) &&
        'modelRoute' in record &&
        !areModelRoutesHistoryCompatible(record.modelRoute, target),
    )
    const hasLegacyCompact = active.some(
      (record) =>
        record.kind === 'compact_summary' && !('modelRoute' in record),
    )
    if (!hasDirectMismatch && !hasLegacyCompact) return false

    const all = await this.#allHistory(session)
    if (!this.#historyNeedsTransition(active, all, target)) return false

    new MessageHistoryCompiler().compile(session.history)
    const config = this.#configStore.getPublicConfig()
    const document = renderConversationTranscript(all, {
      mode: 'provider_transfer',
      sessionId: session.sessionId,
      title: 'Conversation',
      maxToolResultChars:
        config.limits.maxToolResultTokens *
        config.limits.tokenEstimation.bytesPerToken,
    })
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    try {
      deactivateActiveHistory(session)
      await this.#appendFreshHarness(session, run)
      appendOrchestrationStateCheckpoint(session, run)
      appendConversationTranscript(session, {
        content: conversationTranscriptContent(document),
        route: target,
        sourceThroughSeq: document.sourceThroughSeq,
        sourceHash: document.sourceHash,
        contentHash: document.contentHash,
      })
      await this.#validateActiveHistoryCompilation(session, run)
      await this.#executionState?.commit(session, {
        reason: 'history_transition',
        deactivateThroughSeq: document.sourceThroughSeq,
        invalidate: true,
      })
      run.rootUserMessageId = undefined
      run.harnessMessageIds = []
      return true
    } catch (error) {
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      throw error
    }
  }

  #historyNeedsTransition(
    active: readonly SessionState['history'][number][],
    all: readonly SessionState['history'][number][],
    target: NonNullable<ActiveRun['routes']>['main']['snapshot'],
  ): boolean {
    for (const record of active) {
      if (
        (record.kind === 'assistant_turn' ||
          record.kind === 'conversation_transcript' ||
          record.kind === 'compact_summary') &&
        'modelRoute' in record &&
        !areModelRoutesHistoryCompatible(record.modelRoute, target)
      ) {
        return true
      }
      if (record.kind === 'compact_summary' && !('modelRoute' in record)) {
        const boundary = record.metadata.compact.replacesThroughSeq
        const sourceRoute = [...all]
          .reverse()
          .find(
            (candidate) =>
              candidate.seq <= boundary && candidate.kind === 'assistant_turn',
          )
        if (
          sourceRoute?.kind === 'assistant_turn' &&
          !areModelRoutesHistoryCompatible(sourceRoute.modelRoute, target)
        ) {
          return true
        }
      }
    }
    return false
  }

  async #appendFreshHarness(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    const toolCatalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      swarmMaxAgents: run.swarmToolConfig?.maxAgentsPerJob,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    await appendInitialPromptHarness(session, {
      workspace: session.workspace,
      mode: session.mode,
      config: this.#configStore.getPublicConfig(),
      providerId: session.modelSelection.providerId,
      promptRegistry: this.#promptRegistry,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      workspaceConcurrency: this.#getWorkspaceConcurrency(session),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    })
  }

  async #validateActiveHistoryCompilation(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    const binding = run.routes?.main
    if (!binding) throw new Error('Run main route was not resolved')
    const config = this.#configStore.getPublicConfig()
    const catalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      swarmMaxAgents: run.swarmToolConfig?.maxAgentsPerJob,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    provider.compile({
      history: new MessageHistoryCompiler().compile(session.history),
      route: binding.snapshot,
      tools: catalog.definitions,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
  }

  async #allHistory(session: SessionState): Promise<SessionState['history']> {
    let durable: SessionState['history'] = []
    if (this.#historySource) {
      durable = await this.#historySource.listAllMessages(session.sessionId)
    }
    const merged = new Map(
      [...durable, ...session.history].map((record) => [record.id, record]),
    )
    return [...merged.values()].sort((left, right) => left.seq - right.seq)
  }

  #latestActiveAssistantUsage(
    session: SessionState,
  ): ProviderUsage | undefined {
    const record = [...session.history]
      .reverse()
      .find(
        (candidate) =>
          candidate.inHistory && candidate.kind === 'assistant_turn',
      )
    if (record?.kind !== 'assistant_turn' || !record.metadata?.usage) {
      return undefined
    }
    const usage = record.metadata.usage
    return {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheHitTokens: usage.cachedInputTokens,
      cacheMissTokens: usage.cacheMissTokens,
      raw: {},
    }
  }

  async #writeFailure(
    session: SessionState,
    run: ActiveRun,
    callId: CallId,
    apiKey: string,
    error: unknown,
    diagnostics?: ProviderResponseDiagnostics,
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
      operation: 'compact',
      error,
      ...(diagnostics ? { diagnostics } : {}),
    })
  }

  #recordCompactionFailure(
    session: SessionState,
    run: ActiveRun,
    error: unknown,
  ): void {
    if (run.controller.signal.aborted) return
    const existingDiagnosticId = diagnosticIdForError(error)
    const result = this.#operationalLog?.log({
      level: 'error',
      event: 'compaction.failed',
      sessionId: session.sessionId,
      runId: run.runId,
      ...(session.internalExecution
        ? { agentExecutionId: session.internalExecution.executionId }
        : {}),
      ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
      diagnosticId: existingDiagnosticId,
      code: 'COMPACTION_FAILED',
      error,
    })
    associateDiagnosticId(error, existingDiagnosticId ?? result?.diagnosticId)
  }
}
