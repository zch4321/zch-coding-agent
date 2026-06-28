import { getProviderConfig, type PublicConfig } from '../../shared/config'
import type { RunContext } from '../../shared/context'
import type { RunStatus } from '../../shared/agent-events'
import type { RunId } from '../../shared/ids'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import { appendPromptLayer } from './prompt-harness'
import { id, ipcFault } from './session-common'
import type { SessionCompactCoordinator } from './session-compact-coordinator'
import type { SessionInterjectionCoordinator } from './session-interjection-coordinator'
import type { SessionOrchestrationPlanner } from './session-orchestration-planner'
import type { SessionProviderTurnRunner } from './session-provider-turn'
import { delay, finalStatusFromError } from './session-run-utils'
import type { SessionToolRunner } from './session-tool-runner'
import type { SessionUserTurnPreparer } from './session-user-turn-preparer'
import type { ActiveRun, AgentEventDraft, SessionState } from './session-types'

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

function isCompactSlashCommand(message: string): boolean {
  return /^\/compact(?:\s|$)/iu.test(message.trimStart())
}

export class SessionRunController {
  readonly #configStore: ConfigStore
  readonly #providerTurns: SessionProviderTurnRunner
  readonly #toolRunner: SessionToolRunner
  readonly #compact: SessionCompactCoordinator
  readonly #interjections: SessionInterjectionCoordinator
  readonly #orchestration: SessionOrchestrationPlanner
  readonly #userTurns: SessionUserTurnPreparer
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void

  constructor(options: {
    configStore: ConfigStore
    providerTurns: SessionProviderTurnRunner
    toolRunner: SessionToolRunner
    compact: SessionCompactCoordinator
    interjections: SessionInterjectionCoordinator
    orchestration: SessionOrchestrationPlanner
    userTurns: SessionUserTurnPreparer
    onDiagnostic: (message: string, error?: unknown) => void
    emit: (session: SessionState, event: AgentEventDraft) => void
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
  }

  start(
    session: SessionState,
    clientRequestId: string,
    userMessage?: string,
    context?: RunContext,
  ): RunId {
    const existing = session.clientRequests.get(clientRequestId)

    if (existing) {
      return existing
    }

    const config = this.#configStore.getPublicConfig()
    this.#assertRunPreconditions(config, session)

    if (session.activeRun && isTerminalRunStatus(session.activeRun.status)) {
      session.activeRun = undefined
    }

    if (session.activeRun) {
      ipcFault('CONFLICT', 'This session already has an active run')
    }

    const runId = id<RunId>('run')
    const controller = new AbortController()
    const run: ActiveRun = {
      runId,
      clientRequestId,
      controller,
      status: 'idle',
      toolTokensUsed: 0,
      done: Promise.resolve(),
      pendingInterjections: [],
      processedInterjectionIds: new Set(),
    }

    run.done = this.#run(session, run, userMessage, context)
      .catch((error: unknown) =>
        this.#onDiagnostic(`Run ${run.runId} ended unexpectedly`, error),
      )
      .finally(() => {
        if (session.activeRun === run) {
          session.activeRun = undefined
        }
      })
    session.activeRun = run
    session.clientRequests.set(clientRequestId, runId)
    return runId
  }

  interrupt(session: SessionState, runId: RunId): boolean {
    if (!session.activeRun || session.activeRun.runId !== runId) {
      return false
    }

    this.setRunStatus(session, session.activeRun, 'cancelling')
    this.#interjections.supersedePending(session, session.activeRun)
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    session.activeRun.controller.abort(new Error('Run interrupted'))
    return true
  }

  async cancelForSessionClose(
    session: SessionState,
    graceMs: number,
  ): Promise<boolean> {
    if (!session.activeRun) {
      return true
    }

    this.#interjections.supersedePending(session, session.activeRun)
    session.activeRun.controller.abort(new Error('Session closed'))
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    return Promise.race([
      session.activeRun.done.then(() => true),
      delay(graceMs).then(() => false),
    ])
  }

  setRunStatus(
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ): void {
    run.status = status
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

  #assertRunPreconditions(config: PublicConfig, session: SessionState): void {
    if (
      config.privacy.providerNoticeAccepted?.version !== PROVIDER_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Provider data egress notice must be accepted before starting a run',
        { requiredVersion: PROVIDER_NOTICE_VERSION },
      )
    }

    const provider = getProviderConfig(config, session.provider)

    if (!provider?.credentialConfigured) {
      ipcFault(
        'PRECONDITION_FAILED',
        `${provider?.label ?? session.provider} credential is not configured`,
      )
    }
  }

  async #run(
    session: SessionState,
    run: ActiveRun,
    userMessage?: string,
    context?: RunContext,
  ): Promise<void> {
    const signal = run.controller.signal

    try {
      if (userMessage !== undefined) {
        if (isCompactSlashCommand(userMessage)) {
          await this.#compact.runCompactCommand(session, run, userMessage)
          await this.#finishRun(session, run, 'completed')
          return
        }

        const prepared = await this.#userTurns.prepare(
          session,
          run,
          userMessage,
          context,
        )
        run.currentTurnStartIndex = session.history.length
        for (const appMessage of prepared.appMessages) {
          appendPromptLayer(session, {
            kind: appMessage.kind,
            role: 'user',
            content: appMessage.content,
            source: appMessage.source,
            trusted: false,
            editable: false,
            config: this.#configStore.getPublicConfig(),
          })
        }
        session.history.push({
          role: 'user',
          content: prepared.providerMessage,
        })
        await session.logger.write({
          type: 'user.message',
          sessionId: session.sessionId,
          runId: run.runId,
          text: prepared.visibleMessage,
        })
      }
      await session.logger.write({
        type: 'run.start',
        sessionId: session.sessionId,
        runId: run.runId,
      })

      for (
        let step = 0;
        step < this.#configStore.getPublicConfig().limits.maxStepsPerRun;
        step += 1
      ) {
        if (signal.aborted) {
          throw signal.reason
        }

        // Inject queued interjections at the tool-batch boundary, before the
        // next model continuation. This runs after the previous tool batch has
        // completed (and never splits an assistant tool_call from its
        // tool_result, because executeToolCalls has already finished).
        await this.#interjections.drain(session, run)
        await this.#compact.maybeAutoCompactBeforeProviderCall(session, run)

        const completed = await this.#providerTurns.callProvider(
          session,
          run,
          () => this.setRunStatus(session, run, 'calling_llm'),
        )

        session.history.push(completed.turn)

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
            text: completed.text,
            reasoning: completed.reasoning || undefined,
          })
        }

        if (completed.toolCalls.length === 0) {
          const continuation = await this.#orchestration.nextStep(session, run)
          if (continuation === 'continue') {
            continue
          }

          if (run.pendingInterjections.length > 0) {
            // The assistant reached a final answer with no further
            // continuation. Per the roadmap, pending interjections become the
            // next ordinary user turn rather than forcing extra continuations
            // of this run (which would overwrite the final answer in the
            // renderer). Carry them over so the renderer starts a fresh run.
            await this.#interjections.carryOver(session, run)
          }

          await this.#finishRun(session, run, 'completed')
          return
        }

        this.setRunStatus(session, run, 'evaluating_tools')
        run.lastToolBatchId = id('tool-batch')
        await this.#toolRunner.executeToolCalls(
          session,
          run,
          completed.toolCalls,
        )
      }

      throw new Error('Run exceeded maxStepsPerRun')
    } catch (error) {
      const status = finalStatusFromError(error, signal)
      await this.#finishRun(session, run, status, error)
    }
  }

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
  }
}
