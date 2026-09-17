import { ControlAdmission } from './control-admission'
import type { SessionId } from '../../shared/ids'
import type { RunInterjection } from '../session/session-types'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { SubagentParentContext } from './contracts'
import { SubagentRuntimeError } from './contracts'

export interface ParentAgentMessage {
  text: string
  parent: SubagentParentContext
}

/** Serializes admission per child and retains accepted, not-yet-injected messages in memory. */
export class SubagentConversations {
  readonly #queues = new Map<SessionId, ParentAgentMessage[]>()
  readonly #pumps = new Map<SessionId, Promise<void>>()
  readonly #controls = new ControlAdmission()
  #closed = false

  constructor(
    private readonly ports: {
      active: (
        sessionId: SessionId,
      ) => { promise: Promise<unknown> } | undefined
      inject: (sessionId: SessionId, message: ParentAgentMessage) => boolean
      resume: (record: SubagentExecutionRecord) => void
      launch: (
        record: SubagentExecutionRecord,
        message: ParentAgentMessage,
        wanted: () => boolean,
      ) => Promise<unknown>
      changed?: (record: SubagentExecutionRecord) => void
      failed: (error: unknown) => void
    },
  ) {}

  /** Deduplicates a parent tool call; different call IDs remain independent even for equal text. */
  control<T>(
    record: SubagentExecutionRecord,
    parent: SubagentParentContext,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([parent.sessionId, parent.runId, parent.callId])
    const fingerprint = JSON.stringify([
      record.childSessionId ?? record.id,
      operation,
    ])
    return this.#controls.run(
      record.childSessionId ?? record.id,
      key,
      fingerprint,
      action,
    )
  }

  /** Orders cancellation and pause/resume against message admission for the same child. */
  serialize<T>(
    record: SubagentExecutionRecord,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.#controls.serialize(record.childSessionId ?? record.id, action)
  }

  /** Queues or injects one already authorized message without waiting for a model or capacity. */
  send(record: SubagentExecutionRecord, message: ParentAgentMessage): void {
    if (this.#closed || !record.childSessionId)
      throw new SubagentRuntimeError(
        'SUBAGENT_UNAVAILABLE',
        'Child conversation is unavailable',
      )
    message.parent.signal.throwIfAborted()
    const queue = this.#queues.get(record.childSessionId)
    if (!queue?.length && this.ports.inject(record.childSessionId, message)) {
      this.ports.resume(record)
      return
    }
    this.#queues.set(record.childSessionId, [...(queue ?? []), message])
    if (this.ports.active(record.childSessionId)) this.ports.resume(record)
    this.#pump(record)
  }

  /** Injects messages admitted during Run preparation once the new Run accepts input. */
  flush(record: SubagentExecutionRecord): void {
    const queue = this.#queues.get(record.childSessionId!)
    while (
      queue?.length &&
      this.ports.inject(record.childSessionId!, queue[0]!)
    )
      queue.shift()
  }

  /** Transfers late messages from a settling Run directly to its backend successor. */
  carry(
    record: SubagentExecutionRecord,
    parent: SubagentParentContext,
    messages: RunInterjection[],
  ): void {
    if (this.#closed || !record.childSessionId || !messages.length) return
    const carried = messages.map((message) => ({
      text: message.content,
      parent: {
        ...parent,
        runId: message.parentMessage?.runId ?? parent.runId,
        callId: message.parentMessage?.callId ?? parent.callId,
      },
    }))
    this.#queues.set(record.childSessionId, [
      ...carried,
      ...(this.#queues.get(record.childSessionId) ?? []),
    ])
    this.#pump(record)
  }

  /** Reports accepted messages that must hide a previous completed result. */
  pending(sessionId: SessionId | undefined): number {
    return sessionId ? (this.#queues.get(sessionId)?.length ?? 0) : 0
  }

  /** Removes queued messages at an explicit cancellation boundary. */
  cancel(sessionId: SessionId | undefined): void {
    if (sessionId) this.#queues.delete(sessionId)
  }

  /** Prevents successor creation during application shutdown. */
  close(): void {
    this.#closed = true
    this.#queues.clear()
  }

  /** Waits for already admitted preparation/cleanup to finish after close. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#pumps.values()])
  }

  #pump(record: SubagentExecutionRecord): void {
    const sessionId = record.childSessionId!
    if (this.#pumps.has(sessionId)) return
    let blocked = false
    const pump = Promise.resolve()
      .then(async () => {
        while (!this.#closed && this.pending(sessionId)) {
          const active = this.ports.active(sessionId)
          if (active) {
            await active.promise.catch(() => undefined)
            continue
          }
          const message = this.#queues.get(sessionId)?.[0]
          if (!message) break
          // Keep the message pending throughout route/Run preparation, so polling cannot return stale completion.
          try {
            await this.ports.launch(
              record,
              message,
              () =>
                !this.#closed &&
                this.#queues.get(sessionId)?.includes(message) === true,
            )
          } catch (error) {
            blocked = true
            this.ports.failed(error)
            break
          }
          const queue = this.#queues.get(sessionId)
          if (queue?.[0] === message) queue.shift()
          this.ports.changed?.(record)
        }
      })
      .finally(() => {
        this.#pumps.delete(sessionId)
        if (!blocked && !this.#closed && this.pending(sessionId))
          this.#pump(record)
      })
    this.#pumps.set(sessionId, pump)
    void pump.catch(this.ports.failed)
  }
}
