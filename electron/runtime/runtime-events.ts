import type {
  AgentEvent,
  RunStatus,
  TerminalEvent,
} from '../../shared/agent-events'
import type {
  AgentExecutionEvent,
  AgentExecutionEventDraft,
} from '../../shared/agent-execution'
import type { RunId, SessionId } from '../../shared/ids'

export interface RuntimeEventSink {
  publishAgent(event: AgentEvent): void
  publishAgentExecution(event: AgentExecutionEventDraft): void
  publishTerminal(event: TerminalEvent): void
}

export interface RuntimeEventListener {
  onAgentEvent?: (event: AgentEvent) => void
  onAgentExecutionEvent?: (event: AgentExecutionEvent) => void
  onTerminalEvent?: (event: TerminalEvent) => void
}

export interface RunCompletion {
  sessionId: SessionId
  runId: RunId
  status: Extract<RunStatus, 'completed' | 'cancelled' | 'failed'>
  completedAt: string
  error?: {
    code: string
    message: string
  }
}

export type RuntimeEventUnsubscribe = () => void
