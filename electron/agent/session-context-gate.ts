import type { PolicySignal } from '../../shared/agent-events'
import type { ConfigStore } from '../config/store'
import type { ToolCall, ToolResult } from '../tools/types'
import { ContextIngressFilter } from './context-ingress'
import type { SessionApprovalCoordinator } from '../permission/session-approval'
import type { ActiveRun, SessionState } from './session-types'

export class SessionContextGate {
  readonly #configStore: ConfigStore
  readonly #approvals: SessionApprovalCoordinator
  readonly #ingressFilter = new ContextIngressFilter()

  constructor(options: {
    configStore: ConfigStore
    approvals: SessionApprovalCoordinator
  }) {
    this.#configStore = options.configStore
    this.#approvals = options.approvals
  }

  async preflightToolContext(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
  ): Promise<{ signals: PolicySignal[]; result?: ToolResult }> {
    if (session.mode === 'yolo') {
      return { signals: [] }
    }

    const decision = this.#ingressFilter.evaluatePath(
      this.#configStore.getPublicConfig().permission.sensitiveData,
      call,
    )

    if (decision.action !== 'confirm') {
      return { signals: decision.signals }
    }

    const approval = await this.#approvals.requestContextApproval(
      session,
      run,
      call,
      decision.signals,
      decision.summary,
    )

    return {
      signals: decision.signals,
      ...(approval.decision === 'allow'
        ? {}
        : {
            result:
              approval.decision === 'cancelled'
                ? ({
                    status: 'cancelled',
                    message: 'Context ingress approval was cancelled',
                  } satisfies ToolResult)
                : ({
                    status: 'denied',
                    message:
                      'Tool execution was withheld by sensitive path confirmation',
                  } satisfies ToolResult),
          }),
    }
  }

  async filterToolResultForProvider(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
    result: ToolResult,
  ): Promise<{ result: ToolResult; signals: PolicySignal[] }> {
    if (session.mode === 'yolo') {
      return { result, signals: [] }
    }

    const config = this.#configStore.getPublicConfig()
    const decision = this.#ingressFilter.evaluate(
      config.permission.sensitiveData,
      { call, result },
      { includePaths: false },
    )

    if (decision.action === 'allow' || decision.action === 'warn') {
      return { result, signals: decision.signals }
    }

    const approval = await this.#approvals.requestContextApproval(
      session,
      run,
      call,
      decision.signals,
      decision.summary,
    )
    return {
      result:
        approval.decision === 'allow'
          ? result
          : approval.decision === 'cancelled'
            ? {
                status: 'cancelled',
                message: 'Context ingress approval was cancelled',
              }
            : decision.sanitizedResult,
      signals: decision.signals,
    }
  }
}
