import { getProviderConfig, type PublicConfig } from '../../shared/config'
import type { RunContext } from '../../shared/context'
import type { RunStatus } from '../../shared/agent-events'
import type { MessageId, RunId } from '../../shared/ids'
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
import type { SessionProviderTurnRunner } from './session-provider-turn'
import { delay, finalStatusFromError } from './session-run-utils'
import type { SessionToolRunner } from './session-tool-runner'
import type { SessionUserTurnPreparer } from './session-user-turn-preparer'
import type {
  ActiveRun,
  AgentEventDraft,
  HarnessRunMessage,
  SessionState,
  SessionExecutionStatePort,
} from './session-types'
import type { RunAccessLease } from './workspace-access-coordinator'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'

export interface RunStartOptions {
  routes?: {
    main: ResolvedModelRoute
    compression: ResolvedModelRoute
    approval?: ResolvedModelRoute
  }
  allowedToolIds?: ReadonlySet<string>
  directUserInput?: boolean
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

/** Coordinates the lifecycle, persistence, and access control of a session run. */
export class SessionRunController {
  readonly #configStore: ConfigStore
  readonly #providerTurns: SessionProviderTurnRunner
  readonly #toolRunner: SessionToolRunner
  readonly #compact: SessionCompactCoordinator
  readonly #interjections: SessionInterjectionCoordinator
  readonly #orchestration: SessionOrchestrationPlanner
  readonly #userTurns: SessionUserTurnPreparer
  readonly #onDiagnostic: DiagnosticSink
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #acquireRunAccess: (
    session: SessionState,
    runId: RunId,
  ) => RunAccessLease
  readonly #executionState?: SessionExecutionStatePort
  readonly #beforeRun?: (session: SessionState) => Promise<void>
  readonly #afterRun?: (session: SessionState) => Promise<void>

  /** Creates a controller with the collaborators needed to execute session runs. */
  constructor(options: {
    configStore: ConfigStore
    providerTurns: SessionProviderTurnRunner
    toolRunner: SessionToolRunner
    compact: SessionCompactCoordinator
    interjections: SessionInterjectionCoordinator
    orchestration: SessionOrchestrationPlanner
    userTurns: SessionUserTurnPreparer
    onDiagnostic: DiagnosticSink
    emit: (session: SessionState, event: AgentEventDraft) => void
    acquireRunAccess: (session: SessionState, runId: RunId) => RunAccessLease
    executionState?: SessionExecutionStatePort
    beforeRun?: (session: SessionState) => Promise<void>
    afterRun?: (session: SessionState) => Promise<void>
  }) {
    this.#configStore = options.configStore
    this.#providerTurns = options.providerTurns
    this.#toolRunner = options.toolRunner
    this.#compact = options.compact
    this.#interjections = options.interjections
    this.#orchestration = options.orchestration
    this.#userTurns = options.userTurns
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
    this.#acquireRunAccess = options.acquireRunAccess
    this.#executionState = options.executionState
    this.#beforeRun = options.beforeRun
    this.#afterRun = options.afterRun
  }

  /** Starts a new run, or returns the existing run for a repeated client request. */
  start(
    session: SessionState,
    clientRequestId: string,
    userMessage?: string,
    context?: RunContext,
    harnessMessage?: HarnessRunMessage,
    retryUserMessageId?: MessageId,
    options: RunStartOptions = {},
  ): RunId {
    const existing = session.clientRequests.get(clientRequestId)

    if (existing) {
      return existing
    }

    const config = this.#configStore.getPublicConfig()
    this.#assertRunPreconditions(
      config,
      session,
      options.skipProviderPreconditions ?? false,
    )

    if (session.activeRun && isTerminalRunStatus(session.activeRun.status)) {
      session.activeRun = undefined
    }

    if (session.activeRun) {
      ipcFault('CONFLICT', 'This session already has an active run')
    }

    const runId = id<RunId>('run')
    const access = this.#acquireRunAccess(session, runId)
    const controller = new AbortController()
    const run: ActiveRun = {
      runId,
      clientRequestId,
      controller,
      status: 'idle',
      toolTokensUsed: 0,
      usageRecords: [],
      fileChangeHistoryBytes: config.limits.fileChangeHistoryBytes,
      done: Promise.resolve(),
      releaseRunSlot: access.releaseRunSlot,
      releaseWriter: access.releaseWriter,
      pendingSideEffects: new Set(),
      writerReleasePending: false,
      pendingInterjections: [],
      acceptingInterjections: true,
      processedInterjectionIds: new Set(),
      ...(retryUserMessageId ? { rootUserMessageId: retryUserMessageId } : {}),
      harnessMessageIds: [],
      autoCompactEligible: false,
      requestCommitted: false,
      subagentsEnabled: options.subagentsEnabled ?? config.subagents.enabled,
      directUserInput: options.directUserInput ?? false,
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

    run.done = this.#run(
      session,
      run,
      userMessage,
      context,
      harnessMessage,
      retryUserMessageId,
    )
      .catch((error: unknown) =>
        this.#onDiagnostic(`Run ${run.runId} ended unexpectedly`, error, {
          audience: 'internal',
        }),
      )
      .finally(() => {
        const finalize = () => {
          this.releaseAccess(run)
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
    if (isTerminalRunStatus(status)) {
      this.releaseAccess(run)
    }
    run.status = status
    if (error && status === 'failed') {
      run.failure = {
        code: 'RUN_FAILED',
        message:
          error instanceof Error ? error.message : 'Run failed unexpectedly',
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
              code: 'RUN_FAILED',
              message:
                error instanceof Error
                  ? error.message
                  : 'Run failed unexpectedly',
            },
          }
        : {}),
    })
  }

  /** Releases the run slot immediately and the workspace writer after side effects settle. */
  releaseAccess(run: ActiveRun): void {
    run.releaseRunSlot()
    this.#releaseWriterWhenSettled(run)
  }

  /** Defers writer release until all side effects associated with the run finish. */
  #releaseWriterWhenSettled(run: ActiveRun): void {
    if (run.writerReleasePending) return

    const pending = [...run.pendingSideEffects]
    if (pending.length === 0) {
      run.releaseWriter()
      return
    }

    run.writerReleasePending = true
    void Promise.allSettled(pending).then(() => {
      for (const settlement of pending) {
        run.pendingSideEffects.delete(settlement)
      }
      run.writerReleasePending = false
      this.#releaseWriterWhenSettled(run)
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
    retryUserMessageId?: MessageId,
  ): Promise<void> {
    const signal = run.controller.signal
    const runInputCheckpoint = {
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
        session.modelSelection = {
          providerId: runProvider.id,
          model: runProvider.model,
          reasoning: runProvider.reasoning,
        }
      }
      run.routes ??= await resolveRunRoutes(
        this.#configStore,
        session.modelSelection,
        { onDiagnostic: this.#onDiagnostic },
      )
      const maxStepsPerRun = runConfig.limits.maxStepsPerRun
      let runInputCommitted = retryUserMessageId !== undefined
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
      run.autoCompactEligible = true
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
        await this.#compact.maybeAutoCompactBeforeProviderCall(session, run)
        // Compaction itself is a streamed Provider call. Flush interjections
        // that arrived while the summary was being generated into the newly
        // rebuilt epoch before issuing the continuation request.
        await this.#drainInterjections(session, run)

        const completed = await this.#providerTurns.callProvider(
          session,
          run,
          () => this.setRunStatus(session, run, 'calling_llm'),
        )

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

        const assistantRecord = appendCompletedAssistantTurn(session, {
          parts: completed.parts,
          reasoning: completed.reasoning,
          finishReason: completed.finishReason,
          route: run.routes.main.snapshot,
          continuation: completed.continuation,
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
        run.autoCompactEligible = true
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
