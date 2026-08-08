import type { RunStatus } from '../../shared/agent-events'
import type { CallId, MessageId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ProviderUsage } from '../providers/provider'
import { areModelRoutesHistoryCompatible } from '../../shared/model-route'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import {
  ProviderCompletionError,
  providerRequestDiagnostics,
  type CompletedProviderCompact,
  type ProviderCompactEvent,
  type ProviderResponseDiagnostics,
} from '../providers/provider'
import { createConfiguredProvider } from '../providers/provider-factory'
import { normalizeLlmUsage } from '../providers/usage'
import type { SkillsManager } from '../skills/manager'
import { ContextBudgetError, estimateJsonTokens } from '../tools/context-budget'
import type { ToolRegistry } from '../tools/tool-registry'
import { id, redactJsonSecrets, toJsonValue } from './session-common'
import { modelOutputTokenLimit, modelPromptBudget } from './session-run-utils'
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
import { resolveSessionToolCatalog } from './session-tool-catalog'

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
    if (contextTokens >= profile.contextWindowTokens) {
      throw new ContextBudgetError(
        'Provider usage reached or exceeded the model context window',
      )
    }
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
    const compiled = provider.compileCompact({
      history,
      route: binding.snapshot,
      instructions: input.promptText,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
    if (
      estimateJsonTokens(compiled.request, config.limits.tokenEstimation) >
      modelPromptBudget(binding.modelProfile)
    ) {
      throw new ContextBudgetError(
        'The active history is too large for the compression route',
      )
    }
    await input.beforeProvider?.()
    const callId = id<CallId>('llm')
    let completed:
      | Extract<ProviderCompactEvent, { type: 'completed' }>
      | undefined
    this.#setRunStatus(session, run, 'calling_llm')
    const diagnostics = providerRequestDiagnostics(compiled)
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
          if (input.emitText) {
            this.#emit(session, {
              type: 'assistant.text.delta',
              sessionId: session.sessionId,
              runId: run.runId,
              delta: event.delta,
            })
          }
        } else if (completed) {
          throw new Error('Compact provider produced multiple completions')
        } else {
          completed = event
        }
      }
    } catch (error) {
      if (error instanceof ProviderCompletionError) {
        await this.#writeFailedResponse(
          session,
          run,
          callId,
          binding.apiKey,
          error.diagnostics,
        )
      }
      throw error
    }
    if (!completed) {
      throw new Error('Compact provider stream ended without completion')
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
    return structuredClone(completed.compact)
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
      await this.#preflightActiveHistory(session, run)
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
      await this.#preflightActiveHistory(session, run)
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

  async #preflightActiveHistory(
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
    const compiled = provider.compile({
      history: new MessageHistoryCompiler().compile(session.history),
      route: binding.snapshot,
      tools: catalog.definitions,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
    if (
      estimateJsonTokens(compiled.request, config.limits.tokenEstimation) >
      modelPromptBudget(binding.modelProfile)
    ) {
      throw new ContextBudgetError(
        'Rebuilt history exceeds the target model context budget',
      )
    }
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

  async #writeFailedResponse(
    session: SessionState,
    run: ActiveRun,
    callId: CallId,
    apiKey: string,
    diagnostics: ProviderResponseDiagnostics,
  ): Promise<void> {
    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId,
      rawResponse: redactJsonSecrets(diagnostics.rawResponse, [apiKey]),
      normalizedTurn: null,
      providerState: redactJsonSecrets(diagnostics.providerState, [apiKey]),
      usage: diagnostics.usage,
      timing: toJsonValue(diagnostics.timing),
    })
  }
}
