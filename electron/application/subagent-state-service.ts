import type { MessageRecord } from '../../shared/message'
import type { AgentExecutionCounts } from '../../shared/agent-execution'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import type { ApplicationStateCoordinator } from './application-state-coordinator'
import { ApplicationError } from './application-error'
import { MessageRepository } from '../persistence/message-repository'
import { SessionRepository } from '../persistence/session-repository'
import {
  SubagentRepository,
  type SubagentExecutionRecord,
} from '../persistence/subagent-repository'
import type { InternalSessionOwnership } from '../subagent/contracts'

/** Reports an atomic public-Session leaf-capacity reservation failure. */
export class SubagentCapacityError extends ApplicationError {
  readonly capacityCode = 'SUBAGENT_CAPACITY_EXCEEDED'

  constructor(maxActiveLeaves: number) {
    super(
      'PRECONDITION_FAILED',
      `Subagent capacity exceeded (${maxActiveLeaves} active leaves maximum)`,
      { details: { capacityCode: 'SUBAGENT_CAPACITY_EXCEEDED' } },
    )
    this.name = 'SubagentCapacityError'
  }
}

/** Owns backend-private Subagent lifecycle records and hidden Session commits. */
export class SubagentStateService {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #sessions: SessionRepository
  readonly #messages: MessageRepository
  readonly #subagents: SubagentRepository

  constructor(options: {
    coordinator: ApplicationStateCoordinator
    sessions?: SessionRepository
    messages?: MessageRepository
    subagents?: SubagentRepository
  }) {
    this.#coordinator = options.coordinator
    this.#sessions = options.sessions ?? new SessionRepository()
    this.#messages = options.messages ?? new MessageRepository()
    this.#subagents = options.subagents ?? new SubagentRepository()
  }

  /** Creates an execution or returns the existing record for the same parent Tool call. */
  async createExecution(
    record: SubagentExecutionRecord,
    maxActiveLeaves = 32,
  ): Promise<{ created: boolean; record: SubagentExecutionRecord }> {
    return this.#coordinator.internalCommand((transaction) => {
      const existing = this.#subagents.findByParentCall(transaction, record)
      if (existing) return { created: false, record: existing }
      if (
        this.#subagents.countActiveLeaves(transaction, record.parentSessionId) +
          1 >
        maxActiveLeaves
      ) {
        throw new SubagentCapacityError(maxActiveLeaves)
      }
      this.#subagents.insert(transaction, record)
      return { created: true, record: structuredClone(record) }
    })
  }

  /** Atomically reserves one Swarm root and every prepared child execution. */
  async createSwarmJob(
    root: SubagentExecutionRecord,
    children: readonly SubagentExecutionRecord[],
    maxActiveLeaves = 32,
  ): Promise<{
    created: boolean
    root: SubagentExecutionRecord
    children: SubagentExecutionRecord[]
  }> {
    return this.#coordinator.internalCommand((transaction) => {
      const existing = this.#subagents.findByParentCall(transaction, root)
      if (existing) {
        return {
          created: false,
          root: existing,
          children: this.#subagents
            .listChildren(transaction, {
              parentSessionId: root.parentSessionId,
              parentExecutionId: existing.id,
            })
            .map((entry) => entry.record),
        }
      }
      if (
        root.kind !== 'swarm' ||
        root.parentExecutionId ||
        children.some(
          (child, index) =>
            child.kind !== 'subagent' ||
            child.parentExecutionId !== root.id ||
            child.childOrdinal !== index ||
            child.parentSessionId !== root.parentSessionId ||
            child.parentRunId !== root.parentRunId ||
            child.parentCallId !== root.parentCallId,
        )
      ) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Swarm execution identities are not contiguous and parent-scoped',
        )
      }
      if (
        this.#subagents.countActiveLeaves(transaction, root.parentSessionId) +
          children.length >
        maxActiveLeaves
      ) {
        throw new SubagentCapacityError(maxActiveLeaves)
      }
      this.#subagents.insert(transaction, root)
      for (const child of children) this.#subagents.insert(transaction, child)
      return {
        created: true,
        root: structuredClone(root),
        children: structuredClone([...children]),
      }
    })
  }

  /** Loads one execution record after verifying its public parent Session. */
  async getExecution(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<SubagentExecutionRecord | undefined> {
    return (
      await this.#coordinator.query(
        (reader) =>
          this.#subagents.getOwned(reader, {
            parentSessionId,
            executionId,
          })?.record,
      )
    ).value
  }

  /** Loads the root execution reserved by one parent Tool-call identity. */
  async getRootExecution(input: {
    parentSessionId: SessionId
    parentRunId: RunId
    parentCallId: CallId
  }): Promise<SubagentExecutionRecord | undefined> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents.findByParentCall(reader, input),
      )
    ).value
  }

  /** Returns durable child lifecycle counts for a Swarm root. */
  async executionCounts(
    parentExecutionId: AgentExecutionId,
  ): Promise<AgentExecutionCounts> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents.childCounts(reader, parentExecutionId),
      )
    ).value
  }

  /** Lists every durable child for one owned Swarm root. */
  async listChildren(
    parentSessionId: SessionId,
    parentExecutionId: AgentExecutionId,
  ): Promise<SubagentExecutionRecord[]> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents
          .listChildren(reader, { parentSessionId, parentExecutionId })
          .map((entry) => entry.record),
      )
    ).value
  }

  /** Lists a durable page of root executions for background discovery. */
  async listRoots(input: {
    parentSessionId: SessionId
    before?: import('../../shared/agent-execution').AgentExecutionListCursor
    limit: number
  }): Promise<{
    records: SubagentExecutionRecord[]
    hasMore: boolean
    nextBefore?: import('../../shared/agent-execution').AgentExecutionListCursor
  }> {
    return (
      await this.#coordinator.query((reader) => {
        const page = this.#subagents.listByParentSession(reader, input)
        return {
          records: page.records.map((entry) => entry.record),
          hasMore: page.hasMore,
          ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        }
      })
    ).value
  }

  /** Persists the latest execution status, result, usage, or diagnostic. */
  async updateExecution(record: SubagentExecutionRecord): Promise<void> {
    await this.#coordinator.internalCommand((transaction) => {
      if (!this.#subagents.update(transaction, record)) {
        throw new ApplicationError(
          'NOT_FOUND',
          'Subagent execution was not found',
        )
      }
    })
  }

  /** Marks executions abandoned by an earlier process as interrupted. */
  async interruptActive(timestamp = new Date().toISOString()): Promise<number> {
    return this.#coordinator.internalCommand((transaction) =>
      this.#subagents.interruptActive(transaction, timestamp),
    )
  }

  /** Atomically inserts a hidden Session, its ownership, and its initial messages. */
  async commitFirstTurn(input: {
    session: SessionRecord
    messages: readonly MessageRecord[]
    ownership: InternalSessionOwnership
  }): Promise<SessionRecord> {
    assertMessageAppend(input.session, 0, input.messages)
    return this.#coordinator.internalCommand((transaction) => {
      if (this.#sessions.getAny(transaction, input.session.id)) {
        throw new ApplicationError(
          'CONFLICT',
          'Internal Session already exists',
        )
      }
      this.#sessions.insert(transaction, input.session)
      this.#subagents.attachSession(transaction, {
        sessionId: input.session.id,
        executionId: input.ownership.executionId,
        parentSessionId: input.ownership.parentSessionId,
        createdAt: input.ownership.createdAt,
      })
      this.#messages.insertMany(transaction, input.messages)
      return structuredClone(input.session)
    })
  }

  /** Atomically appends messages and metadata to an existing hidden Session. */
  async commitMutation(input: {
    session: SessionRecord
    expectedRevision: number
    expectedLastSeq: number
    messages: readonly MessageRecord[]
    deactivateThroughSeq?: number
  }): Promise<SessionRecord> {
    assertMessageAppend(input.session, input.expectedLastSeq, input.messages)
    return this.#coordinator.internalCommand((transaction) => {
      const current = this.#sessions.getAny(transaction, input.session.id)
      if (!current) {
        throw new ApplicationError(
          'NOT_FOUND',
          'Internal Session was not found',
        )
      }
      if (
        current.revision !== input.expectedRevision ||
        current.lastSeq !== input.expectedLastSeq
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Internal Session revision changed before commit',
        )
      }
      if (input.deactivateThroughSeq !== undefined) {
        this.#messages.deactivateHistoryThrough(
          transaction,
          input.session.id,
          input.deactivateThroughSeq,
        )
      }
      this.#messages.insertMany(transaction, input.messages)
      if (
        !this.#sessions.update(transaction, input.session, current.revision)
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Internal Session update was lost',
        )
      }
      return structuredClone(input.session)
    })
  }

  /** Loads one hidden Session and its active canonical history for recovery. */
  async loadRuntimeState(sessionId: SessionId): Promise<{
    record: SessionRecord
    activeHistory: MessageRecord[]
  }> {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#subagents.isInternalSession(reader, sessionId)) {
          throw new ApplicationError(
            'NOT_FOUND',
            'Internal Session was not found',
          )
        }
        const record = this.#sessions.getAny(reader, sessionId)
        if (!record) {
          throw new ApplicationError(
            'NOT_FOUND',
            'Internal Session was not found',
          )
        }
        return {
          record,
          activeHistory: this.#messages.listActiveHistory(reader, sessionId),
        }
      })
    ).value
  }
}

function assertMessageAppend(
  session: SessionRecord,
  previousLastSeq: number,
  messages: readonly MessageRecord[],
): void {
  let expected = previousLastSeq + 1
  for (const message of messages) {
    if (message.sessionId !== session.id || message.seq !== expected) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Internal Session messages must be contiguous and session-scoped',
      )
    }
    expected += 1
  }
  const nextLastSeq = messages.at(-1)?.seq ?? previousLastSeq
  if (session.lastSeq !== nextLastSeq) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Internal Session lastSeq does not match its append batch',
    )
  }
}
