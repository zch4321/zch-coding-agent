import type { AgentEvent } from '../../shared/agent-events'
import type { SessionId } from '../../shared/ids'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import {
  TERMINAL_RUN_STATUSES,
  type CarryoverInterjection,
  type SessionOverlay,
} from './agent-runtime-helpers'
import { useAgentReplicaStore } from './agent-replica'

interface RuntimeEventTarget {
  globalError: string
  overlays: Record<string, SessionOverlay>
  carryoversBySessionId: Record<string, CarryoverInterjection[]>
  carryoverStartingBySessionId: Record<string, boolean>
  workspaceWriters: Record<string, SessionId>
  workspaceFileRevision: number
  ensureOverlay(sessionId: SessionId): SessionOverlay
  hydrateRuntime(runtime: ActiveRunPublicSnapshot | undefined): void
  flushCarryovers(sessionId: SessionId): Promise<boolean>
}

/** Reconciles one ordered live-run event into its per-Session overlay. */
export function handleRuntimeAgentEvent(
  target: RuntimeEventTarget,
  event: AgentEvent,
): void {
  if (event.type === 'session.closed') {
    delete useAgentReplicaStore().traceCaptureBySessionId[event.sessionId]
    delete target.overlays[event.sessionId]
    delete target.carryoversBySessionId[event.sessionId]
    delete target.carryoverStartingBySessionId[event.sessionId]
    return
  }
  const overlay = target.ensureOverlay(event.sessionId)
  if (event.seq <= overlay.lastEventSeq) return
  if (overlay.lastEventSeq && event.seq !== overlay.lastEventSeq + 1) {
    overlay.diagnostics.push(
      `Runtime event gap: expected ${overlay.lastEventSeq + 1}, received ${event.seq}.`,
    )
    void useAgentReplicaStore()
      .loadSession(event.sessionId)
      .then(() =>
        target.hydrateRuntime(
          useAgentReplicaStore().runtimeBySessionId[event.sessionId],
        ),
      )
  }
  overlay.lastEventSeq = event.seq
  overlay.order += 1

  if (event.type === 'workspace.writer.changed') {
    if (event.status === 'acquired') {
      target.workspaceWriters[event.workspace] = event.writerSessionId
    } else if (
      target.workspaceWriters[event.workspace] === event.writerSessionId
    ) {
      delete target.workspaceWriters[event.workspace]
    }
    return
  }

  if (event.type === 'trace.capture.changed') {
    useAgentReplicaStore().traceCaptureBySessionId[event.sessionId] =
      structuredClone(event.capture)
    return
  }

  if (event.type === 'run.status') {
    if (
      !TERMINAL_RUN_STATUSES.has(event.status) &&
      overlay.terminalReloadRunId &&
      overlay.terminalReloadRunId !== event.runId
    ) {
      overlay.text = ''
      overlay.reasoning = ''
      overlay.approval = undefined
      overlay.tools = []
      overlay.usage = []
      overlay.interjections = []
    }
    overlay.status = event.status
    overlay.runId = TERMINAL_RUN_STATUSES.has(event.status)
      ? undefined
      : event.runId
    if (!TERMINAL_RUN_STATUSES.has(event.status)) {
      overlay.terminalReloadRunId = undefined
    }
    if (event.error) target.globalError = event.error.message
    if (TERMINAL_RUN_STATUSES.has(event.status)) {
      const completedRunId = event.runId
      overlay.terminalReloadRunId = completedRunId
      target.workspaceFileRevision += 1
      void useAgentReplicaStore()
        .loadSession(event.sessionId)
        .then(() => {
          if (overlay.runId || overlay.terminalReloadRunId !== completedRunId) {
            return
          }
          overlay.text = ''
          overlay.reasoning = ''
          overlay.approval = undefined
        })
      void target.flushCarryovers(event.sessionId)
    }
    return
  }

  overlay.runId = event.runId
  if (event.type === 'assistant.text.delta') {
    overlay.text += event.delta
  } else if (event.type === 'assistant.reasoning.delta') {
    overlay.reasoning += event.delta
  } else if (event.type === 'assistant.message.completed') {
    overlay.text = event.text
    overlay.reasoning = event.reasoning ?? overlay.reasoning
  } else if (event.type === 'tool.proposed') {
    overlay.tools = overlay.tools.filter((tool) => tool.callId !== event.callId)
    overlay.tools.unshift({
      callId: event.callId,
      runId: event.runId,
      tool: event.tool,
      args: event.args,
      reason: event.reason,
      status: 'proposed',
      order: overlay.order,
    })
  } else if (event.type === 'tool.completed') {
    const tool = overlay.tools.find(
      (candidate) => candidate.callId === event.callId,
    )
    if (tool) {
      tool.status = 'completed'
      tool.result = event.result
      tool.approval = event.approval
    }
    if (overlay.approval?.callId === event.callId) {
      overlay.approval = undefined
    }
    void useAgentReplicaStore().loadFileChanges(event.sessionId)
  } else if (event.type === 'approval.requested') {
    overlay.approval = {
      runId: event.runId,
      callId: event.callId,
      kind: event.kind,
      tool: event.tool,
      args: event.args,
      reason: event.reason,
      signals: event.policySignals,
      diff: event.diff,
      diffHash: event.diffHash,
      rememberable: event.rememberable,
      rememberArgConstraints: event.rememberArgConstraints,
      expiresAt: event.expiresAt,
      status: 'requested',
      order: overlay.order,
    }
  } else if (event.type === 'llm.usage') {
    overlay.usage.push({
      runId: event.runId,
      callId: event.callId,
      usage: event.usage,
      order: overlay.order,
    })
  } else if (event.type === 'goal.updated') {
    overlay.goal = event.goal ? structuredClone(event.goal) : undefined
  } else if (event.type === 'plan.updated') {
    overlay.plan = event.plan ? structuredClone(event.plan) : undefined
  } else if (event.type === 'interjection.updated') {
    overlay.interjections = overlay.interjections.filter(
      (interjection) => interjection.id !== event.interjectionId,
    )
    overlay.interjections.push({
      id: event.interjectionId,
      status: event.status,
      content: event.content,
      createdAt: event.createdAt,
    })
  } else if (event.type === 'interjection.carryover') {
    overlay.interjections = overlay.interjections.filter(
      (interjection) => interjection.id !== event.interjectionId,
    )
    overlay.interjections.push({
      id: event.interjectionId,
      status: 'carryover',
      content: event.content,
      createdAt: event.createdAt,
    })
    const queue = (target.carryoversBySessionId[event.sessionId] ??= [])
    if (
      !queue.some((interjection) => interjection.id === event.interjectionId)
    ) {
      queue.push({
        id: event.interjectionId,
        runId: event.runId,
        content: event.content,
        createdAt: event.createdAt,
      })
      queue.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
    }
    void target.flushCarryovers(event.sessionId)
  }
}
