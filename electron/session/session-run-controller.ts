import {
  getDefaultModelSelection,
  getProviderConfig,
  type PublicConfig,
} from '../../shared/config'
import type { RunContext } from '../../shared/context'
import type { RunStatus } from '../../shared/agent-events'
import { delay } from '../../shared/async/delay'
import type { DiagnosticId, MessageId, RunId } from '../../shared/ids'
import { randomUUID } from 'node:crypto'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import { resolveRunRoutes } from '../providers/model-route-resolver'
import {
  appendPromptLayer,
  orchestrationRequestContent,
} from './prompt-harness'
import { id, ipcFault, redactJsonSecrets } from './session-common'
import {
  appendCompletedAssistantTurn,
  appendUserInput,
  canonicalHash,
} from './canonical-history'
import type { SessionCompactCoordinator } from './session-compact-coordinator'
import type { SessionInterjectionCoordinator } from './session-interjection-coordinator'
import type { SessionOrchestrationPlanner } from './session-orchestration-planner'
import type { SessionPromptContextCoordinator } from './session-prompt-context-coordinator'
import type { SessionProviderTurnRunner } from './session-provider-turn'
import { finalStatusFromError } from './session-run-utils'
import type { SessionToolRunner } from './session-tool-runner'
import type { SessionUserTurnPreparer } from './session-user-turn-preparer'
import type {
  ActiveRun,
  AgentEventDraft,
  HarnessRunMessage,
  SessionState,
  SessionExecutionStatePort,
} from './session-types'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'
import type { OperationalLogService } from '../operational-logging/service'
import {
  associateDiagnosticId,
  diagnosticIdForError,
} from '../operational-logging/diagnostic-id'
import { classifyRunError } from './run-error-classifier'
import { sanitizeDiagnosticMessage } from '../notifications/backend-notification-reporter'
import { resolveSwarmAvailability } from './session-swarm-availability'

export interface RunStartOptions {
  routes?: {
    main: ResolvedModelRoute
    compression: ResolvedModelRoute
    approval?: ResolvedModelRoute
  }
  allowedToolIds?: ReadonlySet<string>
  directUserInput?: boolean
  directContext?: { content: string; source: string }
  subagentsEnabled?: boolean
  skipProviderPreconditions?: boolean
}

/** Returns whether a run status cannot transition any further. */
function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

/** Returns whether a user message requests an explicit history compaction. */
function isCompactSlashCommand(message: string): boolean {
  return /^\/compact(?:\s|$)/iu.test(message.trimStart())
}

/** Coordinates the lifecycle and persistence of a session run. */
export class SessionRunController {
  readonly #configStore: ConfigStore
  readonly #providerTurns: SessionProviderTurnRunner
  readonly #toolRunner: SessionToolRunner
  readonly #compact: SessionCompactCoordinator
  readonly #interjections: SessionInterjectionCoordinator
  readonly #orchestration: SessionOrchestrationPlanner
  readonly #promptContext: SessionPromptContextCoordinator
  readonly #userTurns: SessionUserTurnPreparer
  readonly #onDiagnostic: DiagnosticSink
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #executionState?: SessionExecutionStatePort
  readonly #beforeRun?: (session: SessionState) => Promise<void>
  readonly #afterRun?: (session: SessionState) => Promise<void>
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined
  readonly #swarmHostEnabled: boolean

  /** Creates a controller with the collaborators needed to execute session runs. */
  constructor(options: {
    configStore: ConfigStore
    providerTurns: SessionProviderTurnRunner
    toolRunner: SessionToolRunner
    compact: SessionCompactCoordinator
    interjections: SessionInterjectionCoordinator
    orchestration: SessionOrchestrationPlanner
    promptContext: SessionPromptContextCoordinator
    userTurns: SessionUserTurnPreparer
    onDiagnostic: DiagnosticSink
    emit: (session: SessionState, event: AgentEventDraft) => void
    executionState?: SessionExecutionStatePort
    beforeRun?: (session: SessionState) => Promise<void>
    afterRun?: (session: SessionState) => Promise<void>
    operationalLog?: Pick<OperationalLogService, 'log'>
    swarmHostEnabled?: boolean
  }) {
    this.#configStore = options.configStore
    this.#providerTurns = options.providerTurns
    this.#toolRunner = options.toolRunner
    this.#compact = options.compact
    this.#interjections = options.interjections
    this.#orchestration = options.orchestration
    this.#promptContext = options.promptContext
    this.#userTurns = options.userTurns
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
    this.#executionState = options.executionState
    this.#beforeRun = options.beforeRun
    this.#afterRun = options.afterRun
    this.#operationalLog = options.operationalLog
    this.#swarmHostEnabled = options.swarmHostEnabled ?? false
  }

  /** Starts a new run, or returns the existing run for a repeated client request. */
  start(
    session: SessionState,
    clientRequestId: string,
    userMessage?: string,
    context?: RunContext,
    harnessMessage?: HarnessRunMessage,
    rootUserMessageId?: MessageId,
    options: RunStartOptions = {},
  ): RunId {
    const existing = session.clientRequests.get(clientRequestId)

    if (existing) {
      return existing
    }

    const config = this.#configStore.getPublicConfig()
    try {
      this.#assertRunPreconditions(
        config,
        session,
        options.skipProviderPreconditions ?? false,
      )
    } catch (error) {
      const classified = classifyRunError(error)
      const result = this.#operationalLog?.log({
        level: 'warn',
        event: 'run.rejected',
        sessionId: session.sessionId,
        ...(session.internalExecution
          ? { agentExecutionId: session.internalExecution.executionId }
          : {}),
        ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
        code: classified.code,
        error,
      })
      associateDiagnosticId(error, result?.diagnosticId)
      throw error
    }

    if (session.activeRun && isTerminalRunStatus(session.activeRun.status)) {
      session.activeRun = undefined
    }

    if (session.activeRun) {
      ipcFault('CONFLICT', 'This session already has an active run')
    }

    const runId = id<RunId>('run')
    const controller = new AbortController()
    const subagentsEnabled =
      options.subagentsEnabled ?? config.subagents.enabled
    const swarm = resolveSwarmAvailability({
      hostEnabled: this.#swarmHostEnabled,
      runSubagentsEnabled: subagentsEnabled,
      config,
    })
    const run: ActiveRun = {
      runId,
      clientRequestId,
      controller,
      status: 'idle',
      usageRecords: [],
      fileChangeHistoryBytes: config.limits.fileChangeHistoryBytes,
      toolOutputLimits: {
        maxToolOutputBytes: config.limits.maxToolOutputBytes,
        maxToolOutputLines: config.limits.maxToolOutputLines,
      },
      done: Promise.resolve(),
      pendingSideEffects: new Set(),
      pendingInterjections: [],
      acceptingInterjections: true,
      processedInterjectionIds: new Set(),
      ...(rootUserMessageId ? { rootUserMessageId } : {}),
      harnessMessageIds: [],
      requestCommitted: false,
      subagentsEnabled,
      maxSubagents: config.subagents.maxSubagents,
      ...(swarm.toolConfig ? { swarmToolConfig: swarm.toolConfig } : {}),
      directUserInput: options.directUserInput ?? false,
      ...(options.directContext
        ? { directContext: structuredClone(options.directContext) }
        : {}),
      ...(options.allowedToolIds
        ? { allowedToolIds: new Set(options.allowedToolIds) }
        : session.allowedToolIds
          ? { allowedToolIds: new Set(session.allowedToolIds) }
          : {}),
      ...(options.routes ? { routes: structuredClone(options.routes) } : {}),
      publicTools: new Map(),
      publicSnapshot: {
        schemaVersion: 1,
        sessionId: session.sessionId,
        runId,
        status: 'idle',
        text: '',
        reasoning: '',
        tools: [],
        interjections: [],
      },
    }

    this.#operationalLog?.log({
      level: 'info',
      event: 'run.started',
      sessionId: session.sessionId,
      runId,
      ...(session.internalExecution
        ? { agentExecutionId: session.internalExecution.executionId }
        : {}),
      ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
    })

    run.done = this.#run(session, run, userMessage, context, harnessMessage)
      .catch((error: unknown) => {
        this.#onDiagnostic(`Run ${run.runId} ended unexpectedly`, error, {
          audience: 'internal',
        })
      })
      .finally(() => {
        const finalize = () => {
          if (session.activeRun === run) {
            session.activeRun = undefined
          }
        }
        if (session.visibility === 'internal') {
          return Promise.allSettled([...run.pendingSideEffects]).then(() => {
            run.pendingSideEffects.clear()
            finalize()
          })
        }
        finalize()
      })
    session.activeRun = run
    session.clientRequests.set(clientRequestId, runId)
    return runId
  }

  /** Requests cancellation of the specified active run. */
  interrupt(session: SessionState, runId: RunId): boolean {
    if (!session.activeRun || session.activeRun.runId !== runId) {
      return false
    }
    if (isTerminalRunStatus(session.activeRun.status)) {
      return false
    }

    session.activeRun.acceptingInterjections = false
    this.setRunStatus(session, session.activeRun, 'cancelling')
    this.#interjections.supersedePending(session, session.activeRun)
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    session.activeRun.controller.abort(new Error('Run interrupted'))
    return true
  }

  /** Cancels an active run and waits up to the supplied grace period for it to settle. */
  async cancelForSessionClose(
    session: SessionState,
    graceMs: number,
  ): Promise<boolean> {
    if (!session.activeRun) {
      return true
    }

    session.activeRun.acceptingInterjections = false
    this.#interjections.supersedePending(session, session.activeRun)
    session.activeRun.controller.abort(new Error('Session closed'))
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    return Promise.race([
      session.activeRun.done.then(() => true),
      delay(graceMs).then(() => false),
    ])
  }

  /** Updates a run status and emits the matching renderer-facing status event. */
  setRunStatus(
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ): void {
    run.status = status
    const classified = classifyRunError(error)
    const failure = {
      ...classified,
      message: sanitizeDiagnosticMessage(classified.message),
    }
    const diagnosticId = diagnosticIdForError(error)
    if (error && status === 'failed') {
      run.failure = {
        ...failure,
        ...(diagnosticId ? { diagnosticId } : {}),
      }
    }
    this.#emit(session, {
      type: 'run.status',
      sessionId: session.sessionId,
      runId: run.runId,
      status,
      ...(error && status === 'failed'
        ? {
            error: {
              ...failure,
              ...(diagnosticId ? { diagnosticId } : {}),
            },
          }
        : {}),
    })
  }

  /** Verifies that the session and provider are ready to accept a new run. */
  #assertRunPreconditions(
    config: PublicConfig,
    session: SessionState,
    skipProvider: boolean,
  ): void {
    if (session.mutationInProgress) {
      ipcFault('CONFLICT', 'Session metadata mutation is still being committed')
    }
    if (
      !skipProvider &&
      config.privacy.providerNoticeAccepted?.version !== PROVIDER_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Provider data egress notice must be accepted before starting a run',
        { requiredVersion: PROVIDER_NOTICE_VERSION },
      )
    }

    const provider = getProviderConfig(config, session.provider)

    if (!skipProvider && !provider?.credentialConfigured) {
      ipcFault(
        'PRECONDITION_FAILED',
        `${provider?.label ?? session.provider} credential is not configured`,
      )
    }
  }

  /** Executes the provider-and-tool loop for an initialized active run. */
  async #run(
    session: SessionState,
    run: ActiveRun,
    userMessage?: string,
    context?: RunContext,
    harnessMessage?: HarnessRunMessage,
  ): Promise<void> {
    const signal = run.controller.signal
    let runInputCheckpoint = {
      history: structuredClone(session.history),
      nextMessageSeq: session.nextMessageSeq,
      goal: session.goal ? structuredClone(session.goal) : undefined,
      plan: session.plan ? structuredClone(session.plan) : undefined,
    }

    try {
      await this.#beforeRun?.(session)
      const runConfig = this.#configStore.getPublicConfig()
      const runProvider = getProviderConfig(runConfig, session.provider)
      if (!runProvider && !run.routes) {
        throw new Error(`Provider is not configured: ${session.provider}`)
      }
      if (!session.modelSelectionPinned) {
        if (!runProvider) {
          throw new Error(`Provider is not configured: ${session.provider}`)
        }
        const defaultSelection = getDefaultModelSelection(runConfig)
        session.modelSelection = {
          providerId: runProvider.id,
          model:
            runProvider.id === defaultSelection.providerId
              ? defaultSelection.model
              : runProvider.model,
          reasoning: defaultSelection.reasoning,
        }
      }
      run.routes ??= await resolveRunRoutes(
        this.#configStore,
        session.modelSelection,
        { onDiagnostic: this.#onDiagnostic },
      )
      const compactCommand =
        userMessage !== undefined &&
        !run.directUserInput &&
        isCompactSlashCommand(userMessage)
      await this.#compact.prepareBeforeRunInput(session, run, {
        compactCommand,
      })
      runInputCheckpoint = {
        history: structuredClone(session.history),
        nextMessageSeq: session.nextMessageSeq,
        goal: session.goal ? structuredClone(session.goal) : undefined,
        plan: session.plan ? structuredClone(session.plan) : undefined,
      }
      await this.#promptContext.refresh(session, run)
      const maxStepsPerRun = runConfig.limits.maxStepsPerRun
      let runInputCommitted = false
      if (harnessMessage) {
        const content = orchestrationRequestContent(
          harnessMessage.kind,
          harnessMessage.text,
        )
        const harnessRecord = appendPromptLayer(session, {
          kind: 'orchestrator',
          content,
          source: harnessMessage.source,
          trusted: true,
          editable: false,
          config: this.#configStore.getPublicConfig(),
        })
        run.harnessMessageIds.push(harnessRecord.id)
        this.#emit(session, {
          type: 'orchestrator.message',
          sessionId: session.sessionId,
          runId: run.runId,
          kind: harnessMessage.kind,
          text: harnessMessage.text,
          promptId: harnessMessage.promptId,
          promptHash: harnessMessage.promptHash,
        })
        await session.logger.write({
          type: 'orchestrator.message',
          sessionId: session.sessionId,
          runId: run.runId,
          kind: harnessMessage.kind,
          text: harnessMessage.text,
          promptId: harnessMessage.promptId,
          promptHash: harnessMessage.promptHash,
        })
      } else if (userMessage !== undefined) {
        if (run.directUserInput) {
          const turnStartSeq = session.nextMessageSeq
          if (run.directContext) {
            const contextRecord = appendPromptLayer(session, {
              kind: 'selected_context',
              content: run.directContext.content,
              source: run.directContext.source,
              trusted: false,
              editable: false,
              config: runConfig,
            })
            run.harnessMessageIds.push(contextRecord.id)
          }
          const userRecord = appendUserInput(session, {
            content: userMessage,
            clientRequestId: run.clientRequestId,
            requestHash: canonicalHash(userMessage),
          })
          run.rootUserMessageId = userRecord.id
          for (const record of session.history) {
            if (record.seq >= turnStartSeq) record.turnId = userRecord.id
          }
          await session.logger.write({
            type: 'user.message',
            sessionId: session.sessionId,
            runId: run.runId,
            text: userMessage,
          })
        } else if (isCompactSlashCommand(userMessage)) {
          const continueRun = await this.#compact.runCompactCommand(
            session,
            run,
            userMessage,
          )
          if (!continueRun) {
            await this.#finishRun(session, run, 'completed')
            return
          }
          runInputCommitted = true
        } else {
          const turnStartSeq = session.nextMessageSeq
          const previousHistory = structuredClone(session.history)
          const previousNextSeq = session.nextMessageSeq
          const previousGoal = session.goal
            ? structuredClone(session.goal)
            : undefined
          const previousPlan = session.plan
            ? structuredClone(session.plan)
            : undefined
          let prepared
          try {
            prepared = await this.#userTurns.prepare(
              session,
              run,
              userMessage,
              context,
            )
          } catch (error) {
            session.history = previousHistory
            session.nextMessageSeq = previousNextSeq
            session.goal = previousGoal
            session.plan = previousPlan
            throw error
          }
          for (const appMessage of prepared.appMessages) {
            const appRecord = appendPromptLayer(session, {
              kind: appMessage.kind,
              content: appMessage.content,
              source: appMessage.source,
              trusted: false,
              editable: false,
              config: this.#configStore.getPublicConfig(),
              visibility: appMessage.visibility,
            })
            run.harnessMessageIds.push(appRecord.id)
          }
          const userRecord = appendUserInput(session, {
            content: prepared.providerMessage,
            clientRequestId: run.clientRequestId,
            requestHash: canonicalHash(userMessage),
            attachments: prepared.attachments,
          })
          run.rootUserMessageId = userRecord.id
          for (const record of session.history) {
            if (record.seq >= turnStartSeq) {
              record.turnId = userRecord.id
            }
          }
          await session.logger.write({
            type: 'user.message',
            sessionId: session.sessionId,
            runId: run.runId,
            text: prepared.visibleMessage,
          })
        }
      }
      if (!runInputCommitted) {
        await this.#executionState?.commit(session, { reason: 'run_input' })
      }
      run.requestCommitted = true
      await session.logger.write({
        type: 'run.start',
        sessionId: session.sessionId,
        runId: run.runId,
      })

      for (
        let step = 0;
        maxStepsPerRun === 0 || step < maxStepsPerRun;
        step += 1
      ) {
        if (signal.aborted) {
          throw signal.reason
        }

        // Inject queued interjections at the tool-batch boundary, before the
        // next model continuation. This runs after the previous tool batch has
        // completed (and never splits an assistant tool_call from its
        // tool_result, because executeToolCalls has already finished).
        await this.#drainInterjections(session, run)
        const completed = await this.#providerTurns.callProvider(
          session,
          run,
          () => this.setRunStatus(session, run, 'calling_llm'),
        )

        const compactRequired =
          this.#compact.assessProviderUsage(run, completed.usage) === 'compact'

        if (completed.text || completed.reasoning) {
          this.#emit(session, {
            type: 'assistant.message.completed',
            sessionId: session.sessionId,
            runId: run.runId,
            text: completed.text,
            ...(completed.reasoning ? { reasoning: completed.reasoning } : {}),
          })
          await session.logger.write({
            type: 'agent.message',
            sessionId: session.sessionId,
            runId: run.runId,
            text: redactJsonSecrets(completed.text, [
              run.routes.main.apiKey,
            ]) as string,
            reasoning: completed.reasoning
              ? (redactJsonSecrets(completed.reasoning, [
                  run.routes.main.apiKey,
                ]) as string)
              : undefined,
          })
        }

        const durableAssistantUsage = {
          ...(completed.usage.promptTokens === undefined
            ? {}
            : { inputTokens: completed.usage.promptTokens }),
          ...(completed.usage.completionTokens === undefined
            ? {}
            : { outputTokens: completed.usage.completionTokens }),
          ...(completed.usage.totalTokens === undefined
            ? {}
            : { totalTokens: completed.usage.totalTokens }),
          ...(completed.usage.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: completed.usage.reasoningTokens }),
          ...(completed.usage.cacheHitTokens === undefined
            ? {}
            : { cachedInputTokens: completed.usage.cacheHitTokens }),
          ...(completed.usage.cacheMissTokens === undefined
            ? {}
            : { cacheMissTokens: completed.usage.cacheMissTokens }),
        }
        const assistantRecord = appendCompletedAssistantTurn(session, {
          parts: completed.parts,
          reasoning: completed.reasoning,
          finishReason: completed.finishReason,
          route: run.routes.main.snapshot,
          continuation: completed.continuation,
          ...(Object.keys(durableAssistantUsage).length > 0
            ? { usage: durableAssistantUsage }
            : {}),
          turnId: run.rootUserMessageId,
        })

        if (completed.toolCalls.length === 0) {
          let continuation: 'continue' | 'finish' = 'finish'
          let orchestrationError: unknown
          try {
            continuation = await this.#orchestration.nextStep(session, run)
          } catch (error) {
            orchestrationError = error
          }
          await this.#executionState?.commit(session, {
            reason: 'assistant_turn',
          })
          if (orchestrationError !== undefined) throw orchestrationError
          if (continuation === 'continue') {
            if (compactRequired) {
              await this.#compact.compactBeforeContinuation(session, run)
            }
            continue
          }

          // No interjection can be accepted after this synchronous boundary.
          // Anything accepted earlier is carried into a fresh ordinary turn.
          run.acceptingInterjections = false
          await this.#interjections.carryOver(session, run)

          await this.#finishRun(session, run, 'completed')
          return
        }

        this.setRunStatus(session, run, 'evaluating_tools')
        run.lastToolBatchId = id('tool-batch')
        let toolBatchFailed = false
        let toolBatchError: unknown
        try {
          await this.#toolRunner.executeToolCalls(
            session,
            run,
            completed.toolCalls,
            assistantRecord.id,
          )
        } catch (error) {
          toolBatchFailed = true
          toolBatchError = error
        }
        await this.#executionState?.commit(session, { reason: 'tool_batch' })
        if (toolBatchFailed) throw toolBatchError
        if (compactRequired) {
          await this.#compact.compactAfterToolBatch(session, run)
        }
      }

      throw new Error(`Run exceeded maxStepsPerRun (${maxStepsPerRun})`)
    } catch (error) {
      if (!run.requestCommitted) {
        session.history = runInputCheckpoint.history
        session.nextMessageSeq = runInputCheckpoint.nextMessageSeq
        session.goal = runInputCheckpoint.goal
        session.plan = runInputCheckpoint.plan
        session.clientRequests.delete(run.clientRequestId)
      }
      const status = finalStatusFromError(error, signal)
      run.acceptingInterjections = false
      this.#interjections.supersedePending(session, run)
      await this.#finishRun(session, run, status, error)
    }
  }

  async #drainInterjections(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    const batch = await this.#interjections.drain(session, run)
    if (!batch) return
    try {
      await this.#executionState?.commit(session, {
        reason: 'interjection',
      })
    } catch (error) {
      this.#interjections.restore(session, run, batch)
      throw error
    }
  }

  /** Records a terminal run status and writes its completion event to the session log. */
  async #finishRun(
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ): Promise<void> {
    if (status === 'failed') {
      const classified = classifyRunError(error)
      const existingDiagnosticId = diagnosticIdForError(error)
      const result = this.#operationalLog?.log({
        level: 'error',
        event: 'run.failed',
        sessionId: session.sessionId,
        runId: run.runId,
        ...(session.internalExecution
          ? { agentExecutionId: session.internalExecution.executionId }
          : {}),
        ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
        diagnosticId: existingDiagnosticId,
        code: classified.code,
        error,
      })
      const diagnosticId =
        existingDiagnosticId ??
        result?.diagnosticId ??
        (`diagnostic:${randomUUID()}` as DiagnosticId)
      associateDiagnosticId(error, diagnosticId)
    } else {
      this.#operationalLog?.log({
        level: 'info',
        event: status === 'cancelled' ? 'run.cancelled' : 'run.completed',
        sessionId: session.sessionId,
        runId: run.runId,
        ...(session.internalExecution
          ? { agentExecutionId: session.internalExecution.executionId }
          : {}),
        ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
      })
    }
    this.setRunStatus(session, run, status, error)
    await session.logger.write({
      type: 'run.end',
      sessionId: session.sessionId,
      runId: run.runId,
      status,
    })
    await this.#afterRun?.(session)
  }
}
