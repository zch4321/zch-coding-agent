import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { BackgroundTargetType } from './contracts'

export type BackgroundAgentType = Exclude<BackgroundTargetType, 'terminal'>

interface AgentHandleRegistration {
  executionId: AgentExecutionId
  parentSessionId: SessionId
  type: BackgroundAgentType
}

let nextAgentHandleId = 1

function allocateAgentHandleId(): number {
  if (!Number.isSafeInteger(nextAgentHandleId)) {
    throw new Error('Background Agent handle space is exhausted')
  }
  const allocated = nextAgentHandleId
  nextAgentHandleId += 1
  return allocated
}

/** Maps durable Agent execution UUIDs to process-local numeric model handles. */
export class BackgroundAgentHandleRegistry {
  readonly #byExecution = new Map<AgentExecutionId, number>()
  readonly #byHandle = new Map<number, AgentHandleRegistration>()

  /** Returns the stable numeric handle for an execution during this process. */
  expose(registration: AgentHandleRegistration): number {
    const existingId = this.#byExecution.get(registration.executionId)
    if (existingId !== undefined) {
      const existing = this.#byHandle.get(existingId)
      if (
        !existing ||
        existing.parentSessionId !== registration.parentSessionId ||
        existing.type !== registration.type
      ) {
        throw new Error('Background Agent handle registration changed identity')
      }
      return existingId
    }
    const id = allocateAgentHandleId()
    this.#byExecution.set(registration.executionId, id)
    this.#byHandle.set(id, { ...registration })
    return id
  }

  /** Resolves an owned numeric handle without accepting durable UUID input. */
  resolve(input: {
    id: number
    parentSessionId: SessionId
    type: BackgroundAgentType
  }): AgentExecutionId | undefined {
    const registration = this.#byHandle.get(input.id)
    return registration?.parentSessionId === input.parentSessionId &&
      registration.type === input.type
      ? registration.executionId
      : undefined
  }
}
