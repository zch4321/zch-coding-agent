import type { AgentEvent, RunStatus } from '../../shared/agent-events'
import type { CallId, RunId, SessionId, TerminalId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { TraceEventSchema, type TraceEvent } from './events'
import { compileSchema } from '../schema-validator'

const validateTraceEvent = compileSchema(TraceEventSchema)

export interface ReplayMessage {
  role: 'user' | 'agent'
  text: string
  reasoning?: string
}

export interface ReplayState {
  schemaVersion: 1
  lastSeq: number
  skippedEvents: number
  sessionId?: SessionId
  workspace?: string
  model?: string
  mode?: string
  closed: boolean
  runs: Partial<Record<RunId, RunStatus>>
  messages: ReplayMessage[]
  tools: Partial<
    Record<
      CallId,
      {
        tool: string
        args: JsonValue
        result: JsonValue
        approvedBy: string
      }
    >
  >
  approvals: Array<{
    callId: CallId
    decision: string
    approver: string
    reason: string
  }>
  terminals: Partial<Record<TerminalId, { direction: string; data: JsonValue }>>
  agentEvents: AgentEvent[]
}

export const INITIAL_REPLAY_STATE: ReplayState = {
  schemaVersion: 1,
  lastSeq: 0,
  skippedEvents: 0,
  closed: false,
  runs: {},
  messages: [],
  tools: {},
  approvals: [],
  terminals: {},
  agentEvents: [],
}

export interface ReplayReducerOptions {
  unknownEvent: 'skip' | 'reject'
}

function normalizeRunStatus(status: string): RunStatus {
  const known: RunStatus[] = [
    'idle',
    'calling_llm',
    'evaluating_tools',
    'awaiting_approval',
    'running_tools',
    'cancelling',
    'completed',
    'cancelled',
    'failed',
  ]

  return known.includes(status as RunStatus)
    ? (status as RunStatus)
    : status === 'complete'
      ? 'completed'
      : 'failed'
}

function textDelta(providerEvent: JsonValue): {
  kind: 'text' | 'reasoning'
  delta: string
} | null {
  if (
    !providerEvent ||
    typeof providerEvent !== 'object' ||
    Array.isArray(providerEvent)
  ) {
    return null
  }

  const type = providerEvent.type
  const delta = providerEvent.delta

  if (typeof delta !== 'string') {
    return null
  }

  if (type === 'text.delta') {
    return { kind: 'text', delta }
  }

  if (type === 'reasoning.delta') {
    return { kind: 'reasoning', delta }
  }

  return null
}

export function reduceTraceEvent(
  current: ReplayState,
  candidate: unknown,
  options: ReplayReducerOptions = { unknownEvent: 'reject' },
): ReplayState {
  if (!validateTraceEvent(candidate)) {
    const version =
      candidate && typeof candidate === 'object'
        ? Reflect.get(candidate, 'schemaVersion')
        : undefined

    if (
      options.unknownEvent === 'skip' &&
      typeof version === 'number' &&
      version > 1
    ) {
      return {
        ...current,
        skippedEvents: current.skippedEvents + 1,
      }
    }

    throw new Error('Trace event is not supported by this replay version')
  }

  const event = candidate as TraceEvent

  if (event.seq <= current.lastSeq) {
    throw new Error('Trace sequence must be strictly increasing')
  }

  const state = structuredClone(current)
  state.lastSeq = event.seq

  switch (event.type) {
    case 'session.start':
      state.sessionId = event.sessionId
      state.workspace = event.workspace
      state.model = event.model
      state.mode = event.mode
      break
    case 'session.end':
      state.closed = true
      state.agentEvents.push({
        schemaVersion: 1,
        type: 'session.closed',
        sessionId: event.sessionId,
        seq: event.seq,
        ts: event.ts,
      })
      break
    case 'session.mode':
      state.mode = event.mode
      break
    case 'run.start':
      state.runs[event.runId] = 'calling_llm'
      state.agentEvents.push({
        schemaVersion: 1,
        type: 'run.status',
        sessionId: event.sessionId,
        runId: event.runId,
        status: 'calling_llm',
        seq: event.seq,
        ts: event.ts,
      })
      break
    case 'run.end': {
      const status = normalizeRunStatus(event.status)
      state.runs[event.runId] = status
      state.agentEvents.push({
        schemaVersion: 1,
        type: 'run.status',
        sessionId: event.sessionId,
        runId: event.runId,
        status,
        seq: event.seq,
        ts: event.ts,
      })
      break
    }
    case 'llm.stream': {
      const delta = textDelta(event.providerEvent)

      if (delta) {
        state.agentEvents.push({
          schemaVersion: 1,
          type:
            delta.kind === 'text'
              ? 'assistant.text.delta'
              : 'assistant.reasoning.delta',
          sessionId: event.sessionId,
          runId: event.runId,
          delta: delta.delta,
          seq: event.seq,
          ts: event.ts,
        })
      }
      break
    }
    case 'approval':
      state.approvals.push({
        callId: event.callId,
        decision: event.decision,
        approver: event.approver,
        reason: event.reason,
      })
      break
    case 'tool.call':
      state.tools[event.callId] = {
        tool: event.tool,
        args: event.args,
        result: event.result,
        approvedBy: event.approvedBy,
      }
      break
    case 'terminal.event':
      state.terminals[event.terminalId] = {
        direction: event.direction,
        data: event.data,
      }
      break
    case 'user.message':
      state.messages.push({ role: 'user', text: event.text })
      break
    case 'agent.message':
      state.messages.push({
        role: 'agent',
        text: event.text,
        reasoning: event.reasoning,
      })
      if (event.runId) {
        state.agentEvents.push({
          schemaVersion: 1,
          type: 'assistant.message.completed',
          sessionId: event.sessionId,
          runId: event.runId,
          text: event.text,
          ...(event.reasoning ? { reasoning: event.reasoning } : {}),
          seq: event.seq,
          ts: event.ts,
        })
      }
      break
    case 'llm.request':
    case 'llm.response':
      break
  }

  return state
}

export function replayTrace(
  events: readonly unknown[],
  options: ReplayReducerOptions = { unknownEvent: 'reject' },
): ReplayState {
  let state = structuredClone(INITIAL_REPLAY_STATE)

  for (const event of events) {
    state = reduceTraceEvent(state, event, options)
  }

  return state
}

export interface ReplayTimelineItem {
  event: TraceEvent
  delayMs: number
}

export function createReplayTimeline(
  events: readonly TraceEvent[],
  speed = 1,
): ReplayTimelineItem[] {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError('Replay speed must be a positive finite number')
  }

  const sorted = [...events].sort((left, right) => left.seq - right.seq)

  return sorted.map((event, index) => {
    const previous = sorted[index - 1]
    const elapsed = previous
      ? Math.max(0, Date.parse(event.ts) - Date.parse(previous.ts))
      : 0

    return {
      event,
      delayMs: elapsed / speed,
    }
  })
}

export interface TraceForkRequest {
  sourceEventId: string
  providerRequest: JsonValue
}

export interface TraceForker {
  fork(request: TraceForkRequest): Promise<{ sessionId: SessionId }>
}
