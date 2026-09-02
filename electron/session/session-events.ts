import type { TerminalEvent } from '../../shared/agent-events'
import type { AgentExecutionEventDraft } from '../../shared/agent-execution'
import type { SessionId } from '../../shared/ids'
import type { TerminalEventDraft } from '../terminal/pool'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type {
  AgentEventDraft,
  SessionState,
  TerminalEventDraftEnvelope,
} from './session-types'

/** Emits Session agent and terminal events through RuntimeEventSink with lifecycle checks. */
export class SessionEventEmitter {
  readonly #eventSink: RuntimeEventSink
  readonly #getSession: (sessionId: SessionId) => SessionState | undefined

  constructor(options: {
    eventSink: RuntimeEventSink
    getSession: (sessionId: SessionId) => SessionState | undefined
  }) {
    this.#eventSink = options.eventSink
    this.#getSession = options.getSession
  }

  /** Emits a session-scoped agent event while enforcing closed-session event rules. */
  emitAgent(session: SessionState, event: AgentEventDraft): void {
    if (session.visibility === 'internal') {
      const projected = projectInternalAgentEvent(session, event)
      if (projected) this.#eventSink.publishAgentExecution(projected)
      return
    }
    if (session.closed && event.type !== 'session.closed') {
      return
    }

    this.#eventSink.publishAgent({
      schemaVersion: 1,
      seq: (session.eventSeq += 1),
      ts: new Date().toISOString(),
      ...event,
    } as Parameters<RuntimeEventSink['publishAgent']>[0])
  }

  /** Looks up the target Session and emits a terminal event when it is still loaded. */
  emitTerminal(event: TerminalEventDraft): void {
    const session = this.#getSession(event.sessionId)
    if (!session || session.visibility === 'internal') {
      return
    }

    const draft: TerminalEventDraftEnvelope =
      event.type === 'terminal.output'
        ? {
            type: 'terminal.output',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            chunk: event.chunk ?? '',
          }
        : {
            type: 'terminal.status',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            status: event.status ?? 'failed',
            ...(event.exitCode !== undefined
              ? { exitCode: event.exitCode }
              : {}),
          }

    this.#eventSink.publishTerminal({
      schemaVersion: 1,
      seq: event.seq,
      ts: new Date().toISOString(),
      ...draft,
    } as TerminalEvent)
  }
}

function projectInternalAgentEvent(
  session: SessionState,
  event: AgentEventDraft,
): AgentExecutionEventDraft | undefined {
  const execution = session.internalExecution
  if (!execution) return undefined
  const identity = {
    executionId: execution.executionId,
    parentSessionId: execution.parentSessionId,
    parentRunId: execution.parentRunId,
    parentCallId: execution.parentCallId,
  }
  switch (event.type) {
    case 'run.status':
      return {
        ...identity,
        type: event.type,
        status: event.status,
        ...(event.error ? { error: { ...event.error } } : {}),
      }
    case 'assistant.text.delta':
    case 'assistant.reasoning.delta':
      return { ...identity, type: event.type, delta: event.delta }
    case 'assistant.activity':
      return { ...identity, type: event.type, activity: event.activity }
    case 'assistant.stream.reset':
      return { ...identity, type: event.type }
    case 'provider.retrying':
      return {
        ...identity,
        type: event.type,
        retry: structuredClone(event.retry),
      }
    case 'assistant.message.completed':
      return {
        ...identity,
        type: event.type,
        text: event.text,
        ...(event.reasoning ? { reasoning: event.reasoning } : {}),
      }
    case 'tool.proposed':
      return {
        ...identity,
        type: event.type,
        callId: event.callId,
        tool: event.tool,
        args: event.args,
        reason: event.reason,
      }
    case 'approval.requested':
      return {
        ...identity,
        type: event.type,
        approval: {
          callId: event.callId,
          kind: event.kind,
          tool: event.tool,
          arguments: structuredClone(event.args),
          reason: event.reason,
          policySignals: structuredClone(event.policySignals),
          rememberable: event.rememberable,
          ...(event.rememberArgConstraints
            ? {
                rememberArgConstraints: structuredClone(
                  event.rememberArgConstraints,
                ),
              }
            : {}),
          expiresAt: event.expiresAt,
        },
      }
    case 'tool.completed':
      return {
        ...identity,
        type: event.type,
        callId: event.callId,
        result: event.result,
      }
    case 'llm.usage':
      return {
        ...identity,
        type: event.type,
        callId: event.callId,
        usage: { ...event.usage, scope: 'subagent' },
      }
    default:
      return undefined
  }
}
