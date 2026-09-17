import { SubagentCapacity } from '../subagent/capacity'
import { appendPromptMessage } from '../session/canonical-history'
import { renderTaggedText } from '../../shared/tagged-message'
import {
  childSessionRecord,
  parseAgentSessionMetadata,
  type AgentSessionMetadata,
} from '../subagent/session-metadata'
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
  type SubagentExecutionState,
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
  readonly capacity = new SubagentCapacity()

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
    options: {
      metadata?: AgentSessionMetadata
      waitForCapacity?: boolean
    } = {},
  ): Promise<{ created: boolean; record: SubagentExecutionRecord }> {
    let acquired = false
    return this.#coordinator
      .internalCommand((transaction) => {
        const existing = this.#subagents.findByParentCall(transaction, record)
        if (existing) return { created: false, record: existing }
        if (
          !options.waitForCapacity &&
          !this.capacity.reserve(
            record.parentSessionId,
            [record.id],
            maxActiveLeaves,
          )
        ) {
          throw new SubagentCapacityError(maxActiveLeaves)
        }
        acquired = !options.waitForCapacity
        try {
          this.#insertChildIdentity(transaction, record, options.metadata)
          this.#subagents.insert(transaction, record)
          return { created: true, record: structuredClone(record) }
        } catch (error) {
          this.capacity.release(record.id)
          throw error
        }
      })
      .catch((error) => {
        if (acquired) this.capacity.release(record.id)
        throw error
      })
  }

  /** Atomically reserves one Swarm root and every prepared child execution. */
  async createSwarmJob(
    root: SubagentExecutionRecord,
    children: readonly SubagentExecutionRecord[],
    maxActiveLeaves = 32,
    metadata?: readonly AgentSessionMetadata[],
  ): Promise<{
    created: boolean
    root: SubagentExecutionRecord
    children: SubagentExecutionRecord[]
  }> {
    let acquired = false
    return this.#coordinator
      .internalCommand((transaction) => {
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
          !this.capacity.reserve(
            root.parentSessionId,
            children.map((child) => child.id),
            maxActiveLeaves,
          )
        ) {
          throw new SubagentCapacityError(maxActiveLeaves)
        }
        acquired = true
        try {
          this.#subagents.insert(transaction, root)
          for (const [index, child] of children.entries()) {
            this.#insertChildIdentity(transaction, child, metadata?.[index])
            this.#subagents.insert(transaction, child)
          }
        } catch (error) {
          for (const child of children) this.capacity.release(child.id)
          throw error
        }
        return {
          created: true,
          root: structuredClone(root),
          children: structuredClone([...children]),
        }
      })
      .catch((error) => {
        if (acquired)
          for (const child of children) this.capacity.release(child.id)
        throw error
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

  /** Samples owned lifecycle states in one query without loading presentation or result payloads. */
  async getExecutionStates(
    parentSessionId: SessionId,
    executionIds: readonly AgentExecutionId[],
  ): Promise<SubagentExecutionState[]> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents.getOwnedStates(reader, parentSessionId, executionIds),
      )
    ).value
  }

  /** Resolves the private Session of one parent-owned execution for resource cleanup. */
  async getChildSessionId(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<SessionId | undefined> {
    return (
      await this.#coordinator.query(
        (reader) =>
          this.#subagents.getOwned(reader, { parentSessionId, executionId })
            ?.childSessionId,
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

  /** Detects current member activity independently of original group counts. */
  async hasActiveChildren(executionId: AgentExecutionId): Promise<boolean> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents.hasActiveChildren(reader, executionId),
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
      if (!['queued', 'preparing', 'running'].includes(record.status))
        this.capacity.release(record.id)
    })
  }

  /** Reads durable child identity and its delegation ceiling under public-parent ownership. */
  async childIdentity(
    parentSessionId: SessionId,
    sessionId: SessionId,
  ): Promise<{ record: SessionRecord; metadata: AgentSessionMetadata }> {
    return (
      await this.#coordinator.query((reader) => {
        const row = reader
          .prepare(
            'SELECT agent_metadata_json FROM sessions WHERE id = ? AND owner_session_id = ?',
          )
          .get(sessionId, parentSessionId)
        const record = this.#sessions.getAny(reader, sessionId)
        if (!row || !record)
          throw new ApplicationError(
            'NOT_FOUND',
            'Child Session was not found for this parent',
          )
        return {
          record,
          metadata: parseAgentSessionMetadata(row.agent_metadata_json),
        }
      })
    ).value
  }

  /** Resolves the latest execution for one persistent, parent-owned child Session. */
  async latestExecution(
    parentSessionId: SessionId,
    sessionId: SessionId,
  ): Promise<SubagentExecutionRecord | undefined> {
    return (
      await this.#coordinator.query((reader) =>
        this.#subagents.latestForSession(reader, parentSessionId, sessionId),
      )
    ).value
  }

  /** Retains accepted parent input when route resolution prevents its new Run from starting. */
  async retainUnstartedMessage(
    parentSessionId: SessionId,
    sessionId: SessionId,
    content: string,
  ): Promise<void> {
    await this.#coordinator.internalCommand((transaction) => {
      const owned = transaction
        .prepare('SELECT 1 FROM sessions WHERE id = ? AND owner_session_id = ?')
        .get(sessionId, parentSessionId)
      const record = this.#sessions.getAny(transaction, sessionId)
      if (!owned || !record)
        throw new ApplicationError('NOT_FOUND', 'Child Session was not found')
      const history = {
        sessionId,
        history: [] as MessageRecord[],
        nextMessageSeq: record.lastSeq + 1,
      }
      const message = appendPromptMessage(history, {
        kind: 'orchestrator',
        content: renderTaggedText('parent_agent_message', content),
        source: 'agent.parent-message',
        trusted: true,
        editable: false,
      })
      message.turnId = message.id
      this.#messages.insertMany(transaction, [message])
      this.#sessions.update(
        transaction,
        {
          ...record,
          lastSeq: message.seq,
          revision: record.revision + 1,
          updatedAt: message.createdAt,
        },
        record.revision,
      )
    })
  }

  #insertChildIdentity(
    transaction: import('../persistence/database-service').PersistenceTransaction,
    record: SubagentExecutionRecord,
    metadata?: AgentSessionMetadata,
  ): void {
    if (!record.childSessionId) return
    if (!metadata) {
      const owner = transaction
        .prepare(
          'SELECT 1 FROM sessions child JOIN sessions parent ON parent.id = child.owner_session_id WHERE child.id = ? AND child.owner_session_id = ? AND parent.lifecycle = ?',
        )
        .get(record.childSessionId, record.parentSessionId, 'active')
      if (!owner)
        throw new ApplicationError(
          'NOT_FOUND',
          'Owned child Session was not found',
        )
      return
    }
    const parent = this.#sessions.get(transaction, record.parentSessionId)
    if (!parent || parent.lifecycle !== 'active')
      throw new ApplicationError(
        'NOT_FOUND',
        'Active parent Session was not found',
      )
    if (this.#sessions.getAny(transaction, record.childSessionId))
      throw new ApplicationError('CONFLICT', 'Child Session already exists')
    this.#sessions.insert(
      transaction,
      childSessionRecord(parent, record, metadata),
    )
    transaction
      .prepare(
        'UPDATE sessions SET owner_session_id = ?, agent_metadata_json = ? WHERE id = ?',
      )
      .run(
        parent.id,
        JSON.stringify(parseAgentSessionMetadata(metadata)),
        record.childSessionId,
      )
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
