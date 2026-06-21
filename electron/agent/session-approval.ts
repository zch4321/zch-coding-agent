import type { PolicySignal, RunStatus } from '../../shared/agent-events'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ToolCall } from '../tools/types'
import {
  type ApprovalRequest,
  type HumanApprovalDecision,
  type RememberApprovalInput,
} from './permission-pipeline'
import { toJsonValue } from './session-common'
import type {
  ActiveRun,
  AgentEventDraft,
  PendingApproval,
  SessionState,
} from './session-types'

interface SessionApprovalCoordinatorOptions {
  configStore: ConfigStore
  pluginBus?: PluginEventBus
  onDiagnostic: (message: string, error?: unknown) => void
  emit: (session: SessionState, event: AgentEventDraft) => void
  setRunStatus: (
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ) => void
}

export class SessionApprovalCoordinator {
  readonly #configStore: ConfigStore
  readonly #pluginBus: PluginEventBus | undefined
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #setRunStatus: SessionApprovalCoordinatorOptions['setRunStatus']

  constructor(options: SessionApprovalCoordinatorOptions) {
    this.#configStore = options.configStore
    this.#pluginBus = options.pluginBus
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
  }

  decide(
    session: SessionState,
    input: {
      sessionId: SessionId
      runId: RunId
      callId: CallId
      decision: 'allow' | 'deny'
      remember?: RememberApprovalInput
    },
  ): boolean {
    const run = session.activeRun

    if (
      !run ||
      run.runId !== input.runId ||
      run.pendingApproval?.callId !== input.callId ||
      run.pendingApproval.expiresAt <= Date.now()
    ) {
      return false
    }

    const pending = run.pendingApproval
    run.pendingApproval = undefined
    pending.resolve({
      decision: input.decision,
      remember: input.decision === 'allow' ? input.remember : undefined,
    })
    return true
  }

  async requestToolApproval(
    session: SessionState,
    run: ActiveRun,
    request: ApprovalRequest,
  ): Promise<HumanApprovalDecision> {
    await this.#pluginBus
      ?.emit('beforeApproval', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        callId: request.call.id,
        policySignals: request.policySignals,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin beforeApproval failed', error),
      )
    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      policySignals: toJsonValue(request.policySignals) as JsonValue[],
      mode: session.mode,
      approver: 'human',
      decision: 'requested',
      reason: request.call.reason,
    })
    this.#setRunStatus(session, run, 'awaiting_approval')
    const decisionPromise = this.#awaitApproval(
      run,
      request.call.id,
      request.expiresAt,
    )
    this.#emit(session, {
      type: 'approval.requested',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      kind: 'tool',
      tool: request.call.toolId,
      args: request.call.args,
      reason: request.call.reason,
      policySignals: request.policySignals,
      diff: request.diff,
      diffHash: request.diffHash,
      rememberable: request.rememberable,
      rememberArgConstraints: request.rememberArgConstraints,
      expiresAt: request.expiresAt,
    })

    const decision = await decisionPromise

    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      policySignals: toJsonValue(request.policySignals) as JsonValue[],
      mode: session.mode,
      approver: 'human',
      decision: decision.decision,
      reason:
        decision.decision === 'allow'
          ? 'Approved by user'
          : decision.decision === 'deny'
            ? 'Denied by user'
            : 'Approval cancelled',
    })
    this.#setRunStatus(session, run, 'running_tools')
    return decision
  }

  async requestContextApproval(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
    signals: PolicySignal[],
    summary: string,
  ): Promise<HumanApprovalDecision> {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

    await this.#pluginBus
      ?.emit('beforeApproval', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        callId: call.id,
        policySignals: signals,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin beforeApproval failed', error),
      )
    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      policySignals: toJsonValue(signals) as JsonValue[],
      mode: this.#configStore.getPublicConfig().permission.sensitiveData.mode,
      approver: 'human',
      decision: 'requested',
      reason: summary,
    })
    this.#setRunStatus(session, run, 'awaiting_approval')
    const approvalPromise = this.#awaitApproval(run, call.id, expiresAt)
    this.#emit(session, {
      type: 'approval.requested',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      kind: 'context',
      tool: call.toolId,
      args: call.args,
      reason: summary,
      policySignals: signals,
      rememberable: false,
      expiresAt,
    })

    const approval = await approvalPromise

    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      policySignals: toJsonValue(signals) as JsonValue[],
      mode: this.#configStore.getPublicConfig().permission.sensitiveData.mode,
      approver: 'human',
      decision: approval.decision,
      reason:
        approval.decision === 'allow'
          ? 'Approved by user'
          : approval.decision === 'deny'
            ? 'Denied by user'
            : 'Approval cancelled',
    })
    this.#setRunStatus(session, run, 'running_tools')
    return approval
  }

  #awaitApproval(
    run: ActiveRun,
    callId: CallId,
    expiresAt: string,
  ): Promise<HumanApprovalDecision> {
    return new Promise<HumanApprovalDecision>((resolve) => {
      const finish = (decision: HumanApprovalDecision) => {
        if (run.pendingApproval?.callId === callId) {
          run.pendingApproval = undefined
        }
        clearTimeout(timer)
        run.controller.signal.removeEventListener('abort', abort)
        resolve(decision)
      }
      const pending: PendingApproval = {
        callId,
        expiresAt: new Date(expiresAt).getTime(),
        resolve: finish,
      }
      run.pendingApproval = pending
      const abort = () => {
        if (run.pendingApproval === pending) {
          finish({ decision: 'cancelled' })
        }
      }
      run.controller.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(
        () => finish({ decision: 'cancelled' }),
        Math.max(0, pending.expiresAt - Date.now()),
      )
    }).finally(() => {
      if (run.pendingApproval?.callId === callId) {
        run.pendingApproval = undefined
      }
    })
  }
}
