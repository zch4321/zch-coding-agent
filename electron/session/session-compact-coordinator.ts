import type { RunStatus } from '../../shared/agent-events'
import type { CallId, MessageId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { CanonicalPromptKind } from '../../shared/message'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import {
  assertCompletedAssistantTurn,
  ProviderCompletionError,
  providerCompletionDiagnostics,
  providerRequestDiagnostics,
  type ProviderEvent,
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
  SessionManagerOptions,
  SessionState,
  SessionExecutionStatePort,
} from './session-types'
import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import {
  appendInitialPromptHarness,
  compactHistoryContent,
  promptResources,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'
import {
  appendCompactSummary,
  appendControlCommand,
  appendPromptMessage,
  appendUserInput,
  canonicalHash,
  canonicalTraceSource,
  deactivateActiveHistory,
  MessageHistoryCompiler,
  messageText,
} from './canonical-history'

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

function compactFollowUp(message: string): string | undefined {
  const match = /^\s*\/compact(?:\s+([\s\S]*?))?\s*$/iu.exec(message)
  const followUp = match?.[1]?.trim()
  return followUp || undefined
}

/** Coordinates automatic prompt-history compaction using config, tools, skills, and prompts. */
export class SessionCompactCoordinator {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #projectMetadata: ProjectMetadataStore | undefined
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

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    projectMetadata?: ProjectMetadataStore
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
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#projectMetadata = options.projectMetadata
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
    this.#executionState = options.executionState
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

  /** Compacts active history before a provider call when eligibility and token budget require it. */
  async maybeAutoCompactBeforeProviderCall(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    if (!run.autoCompactEligible) return
    run.autoCompactEligible = false
    const binding = run.routes?.main
    if (!binding) throw new Error('Run model routes were not resolved')
    const config = this.#configStore.getPublicConfig()
    const tools = this.#toolRegistry.providerDefinitions()
    const compiler = new MessageHistoryCompiler()
    const history = compiler.compile(session.history)
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    const call = provider.compile({
      history,
      route: binding.snapshot,
      tools,
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
    const budget = modelPromptBudget(binding.modelProfile)
    const trigger = Math.floor(
      (budget * config.limits.autoCompactTriggerPercent) / 100,
    )
    if (
      estimateJsonTokens(call.request, config.limits.tokenEstimation) < trigger
    ) {
      return
    }

    const prompt = this.#orchestratorMessages.prompt('compact')
    const promptText = [
      prompt.text,
      '',
      'Summarize the complete active history as a continuation checkpoint.',
      'The original run-start user request will be replayed before this checkpoint.',
      'Treat the checkpoint as the latest state and do not repeat completed work.',
    ].join('\n')
    await this.#orchestratorMessages.emit(session, run, {
      kind: 'compact-auto',
      text: promptText,
      resource: prompt.resource,
      injectIntoHistory: false,
    })
    const summary = await this.#createCompactSummary(
      session,
      run,
      promptText,
      history.messages,
      false,
    )
    const replayedRootUserMessageId = await this.#rewrite(session, run, {
      summary,
      sourceHash: history.sourceHash,
      replacesThroughSeq: history.messages.at(-1)!.seq,
      resource: prompt.resource,
      replayRootUser: true,
      commit: true,
    })
    if (run.rootUserMessageId && !replayedRootUserMessageId) {
      throw new Error('Auto-compact root user message was not rebuilt')
    }
    run.rootUserMessageId = replayedRootUserMessageId
  }

  /**
   * Returns true when `/compact <text>` appended a new user input and the
   * current run must continue into the normal React loop.
   */
  async runCompactCommand(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
  ): Promise<boolean> {
    const history = new MessageHistoryCompiler().compile(session.history)
    const prompt = this.#orchestratorMessages.prompt('compact')
    const beforeCommandHistory = structuredClone(session.history)
    const beforeCommandNextSeq = session.nextMessageSeq
    let commandRecord:
      | Extract<SessionState['history'][number], { kind: 'user_input' }>
      | undefined
    const summary = await this.#createCompactSummary(
      session,
      run,
      prompt.text,
      history.messages,
      true,
      async () => {
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
    )
    if (!commandRecord) {
      throw new Error('Compact command was not journaled before Provider use')
    }
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    const previousRootUserMessageId = run.rootUserMessageId
    try {
      const followUp = compactFollowUp(userMessage)
      const derivedUserMessageId = await this.#rewrite(session, run, {
        summary,
        sourceHash: history.sourceHash,
        replacesThroughSeq: history.messages.at(-1)!.seq,
        resource: prompt.resource,
        replayRootUser: false,
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
        if (!derivedUserMessageId) {
          throw new Error('Compact follow-up payload was not rebuilt')
        }
        run.rootUserMessageId = derivedUserMessageId
        await session.logger.write({
          type: 'user.message',
          sessionId: session.sessionId,
          runId: run.runId,
          text: followUp,
        })
      }
      await this.#executionState?.commit(session, {
        reason: 'compact',
        deactivateThroughSeq: history.messages.at(-1)!.seq,
        invalidate: true,
      })
      if (followUp) return true
    } catch (error) {
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      run.rootUserMessageId = previousRootUserMessageId
      throw error
    }

    this.#emit(session, {
      type: 'assistant.message.completed',
      sessionId: session.sessionId,
      runId: run.runId,
      text: summary,
    })
    await session.logger.write({
      type: 'agent.message',
      sessionId: session.sessionId,
      runId: run.runId,
      text: redactJsonSecrets(summary, [
        run.routes!.compression.apiKey,
      ]) as string,
    })
    return false
  }

  async #createCompactSummary(
    session: SessionState,
    run: ActiveRun,
    promptText: string,
    sourceMessages: readonly SessionState['history'][number][],
    emitText: boolean,
    beforeProvider?: () => Promise<void>,
  ): Promise<string> {
    const binding = run.routes?.compression
    if (!binding) throw new Error('Compression route was not resolved')
    const config = this.#configStore.getPublicConfig()
    const temporary = {
      sessionId: session.sessionId,
      history: structuredClone(sourceMessages) as SessionState['history'],
      nextMessageSeq: (sourceMessages.at(-1)?.seq ?? 0) + 1,
    }
    appendPromptMessage(temporary, {
      kind: 'orchestrator',
      content: promptText,
      source: 'orchestration.compact',
      trusted: true,
      editable: false,
    })
    const history = new MessageHistoryCompiler().compile(temporary.history)
    const provider =
      this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
      createConfiguredProvider(
        binding.provider,
        binding.apiKey,
        this.#fetchImpl,
        binding.snapshot.endpoint,
      )
    const compiled = provider.compile({
      history,
      route: binding.snapshot,
      tools: [],
      maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
    })
    const budget = modelPromptBudget(binding.modelProfile)
    if (
      estimateJsonTokens(compiled.request, config.limits.tokenEstimation) >
      budget
    ) {
      throw new ContextBudgetError(
        'The full active history is too large for the compression route',
      )
    }
    await beforeProvider?.()
    const callId = id<CallId>('llm')
    let text = ''
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined
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
      for await (const event of provider.stream(compiled, {
        signal: run.controller.signal,
      })) {
        if (event.type === 'text.delta') {
          text += event.delta
          if (emitText) {
            this.#emit(session, {
              type: 'assistant.text.delta',
              sessionId: session.sessionId,
              runId: run.runId,
              delta: event.delta,
            })
          }
        } else if (event.type === 'completed') {
          if (completed) {
            throw new Error('Compact provider produced multiple completions')
          }
          completed = event
        }
      }
    } catch (error) {
      const failure =
        error instanceof ProviderCompletionError
          ? error.diagnostics
          : completed
            ? providerCompletionDiagnostics(completed)
            : undefined
      if (failure) {
        await this.#writeFailedResponse(
          session,
          run,
          callId,
          binding.apiKey,
          failure,
        )
      }
      throw error
    }
    if (!completed) {
      throw new Error('Compact provider stream ended without completion')
    }
    const canonical = completed.turn
    let summary: string
    try {
      assertCompletedAssistantTurn(canonical)
      if (canonical.toolCalls.length > 0) {
        throw new Error('Compact summary provider returned tool calls')
      }
      summary =
        text ||
        canonical.parts
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
      if (!summary.trim()) throw new Error('Compact summary was empty')
    } catch (error) {
      await this.#writeFailedResponse(
        session,
        run,
        callId,
        binding.apiKey,
        providerCompletionDiagnostics(completed),
      )
      throw error
    }

    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId,
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
    const usage = normalizeLlmUsage({
      scope: 'compression',
      config,
      provider: binding.provider,
      model: binding.snapshot.model,
      modelProfile: binding.modelProfile,
      usage: canonical.usage,
    })
    if (usage) {
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
    return summary.trim()
  }

  async #rewrite(
    session: SessionState,
    run: ActiveRun,
    input: {
      summary: string
      sourceHash: string
      replacesThroughSeq: number
      resource?: ReturnType<SessionOrchestratorMessages['prompt']>['resource']
      replayRootUser: boolean
      commit: boolean
      derivedPayload?: {
        content: string
        sourceMessageId: MessageId
      }
    },
  ): Promise<MessageId | undefined> {
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    const root = run.rootUserMessageId
      ? session.history.find((record) => record.id === run.rootUserMessageId)
      : undefined
    const runHarness = run.harnessMessageIds.flatMap((messageId) => {
      const record = session.history.find((item) => item.id === messageId)
      return record ? [record] : []
    })
    try {
      deactivateActiveHistory(session)
      await appendInitialPromptHarness(session, {
        workspace: session.workspace,
        mode: session.mode,
        config: this.#configStore.getPublicConfig(),
        providerId: session.modelSelection.providerId,
        promptRegistry: this.#promptRegistry,
        projectMetadata: this.#projectMetadata,
        skillSummary: this.#skillsManager?.summaryPrompt(),
        workspaceConcurrency: this.#getWorkspaceConcurrency(session),
        toolNames: this.#toolRegistry.list().map((tool) => tool.id),
        signal: run.controller.signal,
      })
      for (const record of runHarness) {
        const layer =
          record.metadata && 'layer' in record.metadata
            ? record.metadata.layer
            : undefined
        if (!layer) continue
        const prompt =
          record.metadata && 'prompt' in record.metadata
            ? record.metadata.prompt
            : undefined
        appendPromptMessage(session, {
          kind: record.kind as CanonicalPromptKind,
          content: messageText(record),
          source: layer.source,
          trusted: layer.trusted,
          editable: layer.editable,
          hash: layer.hash,
          ...(prompt
            ? {
                resource: {
                  id: prompt.resourceId,
                  version: prompt.version,
                  path: layer.source,
                  sha256: prompt.hash,
                },
              }
            : {}),
        })
      }
      const replayedRootUser =
        input.replayRootUser && root?.kind === 'user_input'
          ? appendUserInput(session, {
              content: messageText(root),
              replayedFromMessageId:
                root.metadata && 'replayedFromMessageId' in root.metadata
                  ? root.metadata.replayedFromMessageId
                  : root.id,
            })
          : undefined
      appendCompactSummary(session, {
        content: compactHistoryContent(
          [input.summary, '', compactOrchestrationState(session)].join('\n'),
        ),
        replacesThroughSeq: input.replacesThroughSeq,
        sourceHash: input.sourceHash,
        resource: input.resource,
      })
      const derivedUser = input.derivedPayload
        ? appendUserInput(session, {
            content: input.derivedPayload.content,
            derivedFromMessageId: input.derivedPayload.sourceMessageId,
          })
        : undefined

      const binding = run.routes?.main
      if (!binding) throw new Error('Run main route was not resolved')
      const tools = this.#toolRegistry.providerDefinitions()
      const history = new MessageHistoryCompiler().compile(session.history)
      const config = this.#configStore.getPublicConfig()
      const provider =
        this.#providerFactory?.({ config, apiKey: binding.apiKey }) ??
        createConfiguredProvider(
          binding.provider,
          binding.apiKey,
          this.#fetchImpl,
          binding.snapshot.endpoint,
        )
      const compiled = provider.compile({
        history,
        route: binding.snapshot,
        tools,
        maxOutputTokens: modelOutputTokenLimit(binding.modelProfile),
      })
      const budget = modelPromptBudget(binding.modelProfile)
      if (
        estimateJsonTokens(compiled.request, config.limits.tokenEstimation) >
        budget
      ) {
        throw new ContextBudgetError(
          'Compacted history still exceeds the model context budget',
        )
      }
      if (input.commit) {
        await this.#executionState?.commit(session, {
          reason: 'compact',
          deactivateThroughSeq: input.replacesThroughSeq,
          invalidate: true,
        })
      }
      return derivedUser?.id ?? replayedRootUser?.id
    } catch (error) {
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      throw error
    }
  }
}
