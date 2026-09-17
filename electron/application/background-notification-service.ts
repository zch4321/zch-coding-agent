import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { HarnessRunMessage } from '../session/session-types'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'

/** Attempts Desktop wakeups at lifecycle event occurrence; stores neither deferred events nor replay state. */
export class BackgroundNotificationService {
  readonly #inflight = new Set<Promise<void>>()
  #closed = false

  constructor(
    private readonly ports: {
      enabled: boolean
      eligible: (sessionId: SessionId) => boolean
      claim: (sessionId: SessionId) => object | undefined
      message: (
        sessionId: SessionId,
        executionId: AgentExecutionId,
      ) => Promise<HarnessRunMessage>
      start: (
        sessionId: SessionId,
        claim: object,
        message: HarnessRunMessage,
      ) => unknown
      diagnostic: (error: unknown) => void
    },
  ) {}

  /** Routes a new worker transition; ordinary initial Swarm completions stay within the group. */
  child(
    record: SubagentExecutionRecord,
    transition: 'settled' | 'paused',
    reason?: 'timeout' | 'requested',
  ): void {
    if (transition === 'paused') {
      if (record.parentExecutionId || reason === 'timeout')
        this.#attempt(
          record.parentSessionId,
          record.parentExecutionId ?? record.id,
        )
    } else if (record.status === 'completed' || record.status === 'failed') {
      if (!record.parentExecutionId || record.status === 'failed')
        this.#attempt(
          record.parentSessionId,
          record.parentExecutionId ?? record.id,
        )
    }
  }

  /** Announces a fully settled original Swarm result, excluding explicit cancellation. */
  swarm(record: SubagentExecutionRecord): void {
    if (['completed', 'partial', 'failed'].includes(record.status))
      this.#attempt(record.parentSessionId, record.id)
  }

  /** Prevents new attempts before host shutdown and lets admitted projection reads finish. */
  async dispose(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#inflight])
  }

  #attempt(sessionId: SessionId, executionId: AgentExecutionId): void {
    if (this.#closed || !this.ports.enabled || !this.ports.eligible(sessionId))
      return
    const claim = this.ports.claim(sessionId)
    if (!claim) return
    const attempt = this.ports
      .message(sessionId, executionId)
      .then((message) => {
        if (this.#closed || !this.ports.eligible(sessionId)) return
        this.ports.start(sessionId, claim, message)
      })
      .catch((error) => this.ports.diagnostic(error))
      .finally(() => this.#inflight.delete(attempt))
    this.#inflight.add(attempt)
  }
}
