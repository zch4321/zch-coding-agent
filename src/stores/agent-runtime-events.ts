import type { AgentEvent } from '../../shared/agent-events'
import type { SessionId } from '../../shared/ids'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import {
  TERMINAL_RUN_STATUSES,
  type CarryoverInterjection,
  type SessionOverlay,
} from './agent-runtime-helpers'
import { useAgentReplicaStore } from './agent-replica'
import { useNotificationStore } from './notifications'

interface RuntimeEventTarget {
  overlays: Record<string, SessionOverlay>
  carryoversBySessionId: Record<string, CarryoverInterjection[]>
  carryoverStartingBySessionId: Record<string, boolean>
  workspaceWriters: Record<string, SessionId>
  workspaceFileRevision: number
  ensureOverlay(sessionId: SessionId): SessionOverlay
  hydrateRuntime(runtime: ActiveRunPublicSnapshot | undefined): void
  flushCarryovers(sessionId: SessionId): Promise<boolean>
}

type RoutedAgentEvent = Exclude<AgentEvent, { type: 'session.closed' }>
type RoutedAgentEventType = RoutedAgentEvent['type']
type RuntimeEventHandlerMap = {
  [Type in RoutedAgentEventType]: (
    target: RuntimeEventTarget,
    overlay: SessionOverlay,
    event: Extract<RoutedAgentEvent, { type: Type }>,
  ) => void
}

const runtimeEventHandlers = {
  'workspace.writer.changed': (target, _overlay, event) => {
    if (event.status === 'acquired') {
      target.workspaceWriters[event.workspace] = event.writerSessionId
    } else if (
      target.workspaceWriters[event.workspace] === event.writerSessionId
    ) {
      delete target.workspaceWriters[event.workspace]
    }
  },
  'trace.capture.changed': (_target, _overlay, event) => {
    const replica = useAgentReplicaStore()
    const previous = replica.traceCaptureBySessionId[event.sessionId]
    replica.traceCaptureBySessionId[event.sessionId] = structuredClone(
      event.capture,
    )
    if (
      event.capture.state === 'degraded' &&
      (previous?.state !== 'degraded' ||
        previous.warning !== event.capture.warning)
    ) {
      useNotificationStore().warning({
        code: 'TRACE_CAPTURE_DEGRADED',
        message: event.capture.warning ?? 'Trace capture is unavailable.',
        sessionId: event.sessionId,
      })
    }
  },
  'run.status': (target, overlay, event) => {
    if (
      !TERMINAL_RUN_STATUSES.has(event.status) &&
      overlay.terminalReloadRunId &&
      overlay.terminalReloadRunId !== event.runId
    ) {
      overlay.text = ''
      overlay.reasoning = ''
      overlay.streamActivity = undefined
      overlay.approval = undefined
      overlay.tools = []
      overlay.usage = []
      overlay.interjections = []
      overlay.todo = undefined
    }
    overlay.status = event.status
    overlay.runId = TERMINAL_RUN_STATUSES.has(event.status)
      ? undefined
      : event.runId
    if (event.status === 'calling_llm') {
      overlay.streamActivity = undefined
    }
    if (!TERMINAL_RUN_STATUSES.has(event.status)) {
      overlay.terminalReloadRunId = undefined
    }
    if (event.error) {
      useNotificationStore().error({
        code: event.error.code,
        message: event.error.message,
        sessionId: event.sessionId,
        ...(event.error.diagnosticId
          ? { diagnosticId: event.error.diagnosticId }
          : {}),
      })
    }
    if (!TERMINAL_RUN_STATUSES.has(event.status)) return

    const completedRunId = event.runId
    overlay.streamActivity = undefined
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
  },
  'assistant.activity': (_target, overlay, event) => {
    overlay.streamActivity = event.activity
  },
  'assistant.stream.reset': (_target, overlay) => {
    overlay.text = ''
    overlay.reasoning = ''
    overlay.streamActivity = undefined
  },
  'assistant.text.delta': (_target, overlay, event) => {
    overlay.streamActivity = 'output'
    overlay.text += event.delta
  },
  'assistant.reasoning.delta': (_target, overlay, event) => {
    overlay.streamActivity = 'reasoning'
    overlay.reasoning += event.delta
  },
  'assistant.message.completed': (_target, overlay, event) => {
    overlay.text = event.text
    overlay.reasoning = event.reasoning ?? overlay.reasoning
  },
  'tool.attempt': () => undefined,
  'tool.proposed': (_target, overlay, event) => {
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
  },
  'approval.requested': (_target, overlay, event) => {
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
  },
  'tool.completed': (_target, overlay, event) => {
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
  },
  'llm.usage': (_target, overlay, event) => {
    overlay.usage.push({
      runId: event.runId,
      callId: event.callId,
      usage: event.usage,
      order: overlay.order,
    })
  },
  'orchestrator.message': () => undefined,
  'interjection.updated': (_target, overlay, event) => {
    overlay.interjections = overlay.interjections.filter(
      (interjection) => interjection.id !== event.interjectionId,
    )
    overlay.interjections.push({
      id: event.interjectionId,
      status: event.status,
      content: event.content,
      createdAt: event.createdAt,
    })
  },
  'interjection.carryover': (target, overlay, event) => {
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
  },
  'todo.updated': (_target, overlay, event) => {
    overlay.todo = structuredClone(event.todo)
  },
  'goal.updated': (_target, overlay, event) => {
    overlay.goal = event.goal ? structuredClone(event.goal) : undefined
  },
  'plan.updated': (_target, overlay, event) => {
    overlay.plan = event.plan ? structuredClone(event.plan) : undefined
  },
} satisfies RuntimeEventHandlerMap

function dispatchRuntimeEvent(
  target: RuntimeEventTarget,
  overlay: SessionOverlay,
  event: RoutedAgentEvent,
): void {
  if ('runId' in event && event.type !== 'run.status') {
    overlay.runId = event.runId
  }
  const handler = runtimeEventHandlers[event.type] as (
    target: RuntimeEventTarget,
    overlay: SessionOverlay,
    event: RoutedAgentEvent,
  ) => void
  handler(target, overlay, event)
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
    const warning = `Runtime event gap: expected ${overlay.lastEventSeq + 1}, received ${event.seq}. Resynchronizing.`
    overlay.diagnostics.push(warning)
    useNotificationStore().warning({
      code: 'RUNTIME_EVENT_GAP',
      message: warning,
      sessionId: event.sessionId,
    })
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
  dispatchRuntimeEvent(target, overlay, event)
}
