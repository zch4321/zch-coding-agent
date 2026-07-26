import { randomUUID } from 'node:crypto'
import type { PermissionMode } from '../../shared/config'
import { MAX_FORK_MESSAGE_RECORDS } from '../../shared/durable'
import type {
  SessionCommandResult,
  SessionMessageChange,
  SessionSearchHit,
} from '../../shared/domain-state-api'
import type { MessageId, ProjectId, SessionId } from '../../shared/ids'
import {
  isControlCommandUserInput,
  type MessageRecord,
} from '../../shared/message'
import type { ModelSelection } from '../../shared/model-route'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type {
  SessionLifecycle,
  SessionListCursor,
  SessionPage,
  SessionRecord,
  SessionSnapshot,
} from '../../shared/session'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { TraceCaptureStatus } from '../../shared/trace'
import { MessageRepository } from '../persistence/message-repository'
import {
  SessionRepository,
  type SessionListQuery,
} from '../persistence/session-repository'
import {
  ApplicationError,
  normalizeApplicationError,
} from './application-error'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import {
  cloneForkMessage,
  rebuildActiveBranch,
  rewindBoundarySeq,
  terminalToolBatchEnd,
} from './session-branch'
import {
  MessageHistoryCompiler,
  messageText,
} from '../session/canonical-history'

export interface SessionRuntimeGuard {
  assertSessionIdle(sessionId: SessionId): void
  snapshot(sessionId: SessionId): ActiveRunPublicSnapshot | undefined
  traceCaptureStatus?(sessionId: SessionId): TraceCaptureStatus | undefined
  reserveSessionEviction?(sessionId: SessionId): string
  cancelSessionEviction?(sessionId: SessionId, token: string): void
  releaseSession(
    sessionId: SessionId,
    operationToken?: string,
  ): void | Promise<void>
  applySessionRecord?(record: SessionRecord): void | Promise<void>
}

export interface SessionServiceOptions {
  coordinator: ApplicationStateCoordinator
  sessions?: SessionRepository
  messages?: MessageRepository
  runtimeGuard?: SessionRuntimeGuard
  now?: () => string
  createMessageId?: () => MessageId
  onDiagnostic?: (message: string, error?: unknown) => void
}

export interface SessionMetadataPatch {
  title?: string
  permissionMode?: PermissionMode
  modelSelection?: ModelSelection
  goal?: GoalState | null
  plan?: PlanState | null
}

export interface SessionMutation {
  sessionId: SessionId
  expectedRevision: number
  expectedLastSeq: number
  messages?: readonly MessageRecord[]
  metadata?: SessionMetadataPatch
  deactivateThroughSeq?: number
  messageChange?: SessionMessageChange['mode']
  requireIdle?: boolean
}

export type RequestLookup = {
  session: SessionRecord
  userMessage: Extract<MessageRecord, { kind: 'user_input' }>
}

export type FirstTurnCommit =
  | {
      outcome: 'committed'
      result: SessionCommandResult
    }
  | {
      outcome: 'deduplicated'
      value: RequestLookup
    }

/** Provides durable Session queries and revision-checked mutations. */
export class SessionService {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #sessions: SessionRepository
  readonly #messages: MessageRepository
  readonly #runtimeGuard?: SessionRuntimeGuard
  readonly #now: () => string
  readonly #createMessageId: () => MessageId
  readonly #onDiagnostic: (message: string, error?: unknown) => void

  constructor(options: SessionServiceOptions) {
    this.#coordinator = options.coordinator
    this.#sessions = options.sessions ?? new SessionRepository()
    this.#messages = options.messages ?? new MessageRepository()
    this.#runtimeGuard = options.runtimeGuard
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createMessageId =
      options.createMessageId ?? (() => `message:${randomUUID()}` as MessageId)
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Lists Sessions with project, lifecycle, search, and cursor filters. */
  async list(
    query: {
      projectId?: SessionListQuery['projectId']
      lifecycle?: SessionLifecycle
      search?: string
      before?: SessionListCursor
      limit?: number
    } = {},
  ): Promise<SessionPage> {
    return (
      await this.#coordinator.query((reader) =>
        this.#sessions.listPage(reader, query),
      )
    ).value
  }

  /** Builds a Session snapshot with its current message page and runtime state. */
  async get(sessionId: SessionId): Promise<SessionSnapshot> {
    const snapshot = (
      await this.#coordinator.query((reader) => {
        const session = this.#sessions.get(reader, sessionId)
        if (!session) return undefined
        return {
          schemaVersion: 1 as const,
          session,
          messagePage: this.#messages.listPage(reader, sessionId),
        }
      })
    ).value
    if (!snapshot) {
      throw new ApplicationError('NOT_FOUND', 'Session was not found')
    }
    const runtime = this.#runtimeGuard?.snapshot(sessionId)
    const traceCapture = this.#runtimeGuard?.traceCaptureStatus?.(sessionId)
    return {
      ...snapshot,
      ...(runtime ? { runtime } : {}),
      ...(traceCapture ? { traceCapture } : {}),
    }
  }

  /** Reads one durable SessionRecord by ID. */
  async getRecord(sessionId: SessionId): Promise<SessionRecord> {
    const record = (
      await this.#coordinator.query((reader) =>
        this.#sessions.get(reader, sessionId),
      )
    ).value
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'Session was not found')
    }
    return record
  }

  /** Loads active-history messages after verifying that the Session exists. */
  async listActiveHistory(sessionId: SessionId): Promise<MessageRecord[]> {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#sessions.get(reader, sessionId)) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        return this.#messages.listActiveHistory(reader, sessionId)
      })
    ).value
  }

  /** Loads the durable record, active messages, and idempotency results needed for runtime hydration. */
  async loadRuntimeState(
    sessionId: SessionId,
    clientRequestIds: readonly string[] = [],
    onRecord?: (record: SessionRecord) => void,
  ): Promise<{
    record: SessionRecord
    activeHistory: MessageRecord[]
    committedClientRequestIds: string[]
  }> {
    return (
      await this.#coordinator.query((reader) => {
        const record = this.#sessions.get(reader, sessionId)
        if (!record) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        onRecord?.(record)
        const committedClientRequestIds = clientRequestIds.filter(
          (clientRequestId) =>
            this.#messages.findByClientRequestId(
              reader,
              sessionId,
              clientRequestId,
            ) !== undefined,
        )
        return {
          record,
          activeHistory: this.#messages.listActiveHistory(reader, sessionId),
          committedClientRequestIds,
        }
      })
    ).value
  }

  /** Lists a bounded page of Session messages before an optional sequence cursor. */
  async listMessages(
    sessionId: SessionId,
    query: { beforeSeq?: number; limit?: number } = {},
  ) {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#sessions.get(reader, sessionId)) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        return this.#messages.listPage(reader, sessionId, query)
      })
    ).value
  }

  /** Searches visible message text within one Session. */
  async searchMessages(
    sessionId: SessionId,
    input: { text: string; limit?: number },
  ): Promise<MessageRecord[]> {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#sessions.get(reader, sessionId)) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        return this.#messages.searchText(reader, sessionId, input)
      })
    ).value
  }

  /** Searches Session summaries, optionally restricted to one Project. */
  async searchSessions(input: {
    text: string
    projectId?: ProjectId
    limit?: number
  }): Promise<SessionSearchHit[]> {
    return (
      await this.#coordinator.query((reader) => {
        const ids = this.#sessions.searchCandidateIds(reader, input)
        const needle = input.text.trim().toLocaleLowerCase()
        return ids.flatMap((sessionId): SessionSearchHit[] => {
          const session = this.#sessions.get(reader, sessionId)
          if (!session) return []
          if (session.title.toLocaleLowerCase().includes(needle)) {
            return [
              {
                session,
                match: {
                  kind: 'title',
                  snippet: boundedSnippet(session.title),
                },
              },
            ]
          }
          const message = this.#messages.searchText(reader, sessionId, {
            text: input.text,
            limit: 1,
          })[0]
          if (!message) return []
          return [
            {
              session,
              match: {
                kind: 'message',
                messageId: message.id,
                seq: message.seq,
                snippet: boundedSnippet(messageText(message)),
              },
            },
          ]
        })
      })
    ).value
  }

  /** Finds the original visible user message associated with a target message. */
  async getOriginalVisibleUser(
    sessionId: SessionId,
    messageId: MessageId,
  ): Promise<Extract<MessageRecord, { kind: 'user_input' }>> {
    return (
      await this.#coordinator.query((reader) => {
        if (!this.#sessions.get(reader, sessionId)) {
          throw new ApplicationError('NOT_FOUND', 'Session was not found')
        }
        const message = this.#messages.get(reader, sessionId, messageId)
        if (
          !message ||
          message.visibility !== 'visible' ||
          message.kind !== 'user_input' ||
          !('clientRequestId' in message) ||
          isControlCommandUserInput(message)
        ) {
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Retry target must be a visible original user message',
          )
        }
        return message
      })
    ).value
  }

  /** Looks up idempotency state for a client request and optional request hash. */
  async lookupRequest(
    sessionId: SessionId,
    clientRequestId: string,
    requestHash: string,
  ): Promise<RequestLookup | undefined> {
    return (
      await this.#coordinator.query((reader) => {
        const session = this.#sessions.get(reader, sessionId)
        if (!session) return undefined
        const message = this.#messages.findByClientRequestId(
          reader,
          sessionId,
          clientRequestId,
        )
        if (!message) return undefined
        const userMessage = originalUserMessage(message)
        const storedHash =
          userMessage.metadata && 'requestHash' in userMessage.metadata
            ? userMessage.metadata.requestHash
            : undefined
        if (storedHash !== requestHash) {
          throw new ApplicationError(
            'CONFLICT',
            'clientRequestId was already used for different message text',
          )
        }
        return { session, userMessage }
      })
    ).value
  }

  /** Atomically persists a new Session, its initial messages, and request idempotency state. */
  async commitFirstTurn(input: {
    session: SessionRecord
    messages: readonly MessageRecord[]
    requestHash: string
  }): Promise<FirstTurnCommit> {
    assertNewSessionBatch(input.session, input.messages)
    try {
      const result = await this.#coordinator.command(
        'session.changed',
        (transaction) => {
          const existing = this.#sessions.get(transaction, input.session.id)
          if (existing) {
            throw new ApplicationError(
              'CONFLICT',
              'Candidate Session id already exists',
            )
          }
          this.#sessions.insert(transaction, input.session)
          this.#messages.insertMany(transaction, input.messages)
          return {
            session: input.session,
            messageChange: {
              mode: 'upsert' as const,
              records: [...input.messages],
            },
          }
        },
      )
      return { outcome: 'committed', result }
    } catch (error) {
      const normalized = normalizeApplicationError(error)
      if (normalized.code !== 'CONFLICT') throw normalized
      const user = input.messages.find(
        (record) => record.kind === 'user_input' && 'clientRequestId' in record,
      )
      if (user?.kind !== 'user_input' || !('clientRequestId' in user)) {
        throw normalized
      }
      const duplicate = await this.lookupRequest(
        input.session.id,
        user.clientRequestId,
        input.requestHash,
      )
      if (!duplicate) throw normalized
      return { outcome: 'deduplicated', value: duplicate }
    }
  }

  /** Atomically commits messages and metadata after checking revision and sequence expectations. */
  async commitMutation(input: SessionMutation): Promise<SessionCommandResult> {
    return this.#coordinator.command('session.changed', (transaction) => {
      const current = this.#sessions.get(transaction, input.sessionId)
      if (!current) {
        throw new ApplicationError('NOT_FOUND', 'Session was not found')
      }
      if (input.requireIdle) {
        this.#runtimeGuard?.assertSessionIdle(input.sessionId)
      }
      assertSessionRevision(
        current,
        input.expectedRevision,
        input.expectedLastSeq,
      )
      if (current.lifecycle !== 'active') {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Archived Session cannot be modified',
        )
      }
      const records = [...(input.messages ?? [])]
      assertAppendBatch(current, records)
      if (input.deactivateThroughSeq !== undefined) {
        if (
          !Number.isSafeInteger(input.deactivateThroughSeq) ||
          input.deactivateThroughSeq < 1 ||
          input.deactivateThroughSeq > current.lastSeq
        ) {
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Compact boundary is outside committed history',
          )
        }
        this.#messages.setInHistoryThrough(
          transaction,
          input.sessionId,
          input.deactivateThroughSeq,
          false,
        )
      }
      this.#messages.insertMany(transaction, records)
      const next = applyMetadata(
        {
          ...current,
          revision: current.revision + 1,
          lastSeq: records.at(-1)?.seq ?? current.lastSeq,
          updatedAt: this.#now(),
        },
        input.metadata,
      )
      if (!this.#sessions.update(transaction, next, current.revision)) {
        throw revisionConflict(current)
      }
      return {
        session: next,
        messageChange: mutationMessageChange(input, records),
      }
    })
  }

  /** Applies a revision-checked metadata update to a Session record. */
  async update(input: {
    sessionId: SessionId
    expectedRevision: number
    patch: SessionMetadataPatch
  }): Promise<SessionCommandResult> {
    const result = await this.commitMutation({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      expectedLastSeq: (await this.getRecord(input.sessionId)).lastSeq,
      metadata: input.patch,
      messageChange: 'none',
      requireIdle: true,
    })
    try {
      await this.#runtimeGuard?.applySessionRecord?.(
        result.commit.change.session,
      )
    } catch (error) {
      this.#onDiagnostic(
        `Updated Session ${input.sessionId} could not refresh its runtime context`,
        error,
      )
    }
    return result
  }

  /** Archives a Session after reserving and completing its lifecycle eviction. */
  async archive(input: {
    sessionId: SessionId
    expectedRevision: number
  }): Promise<SessionCommandResult> {
    const operationToken = this.#runtimeGuard?.reserveSessionEviction?.(
      input.sessionId,
    )
    let result: SessionCommandResult
    try {
      result = await this.#coordinator.command(
        'session.changed',
        (transaction) => {
          if (!operationToken) {
            this.#runtimeGuard?.assertSessionIdle(input.sessionId)
          }
          const current = this.#sessions.get(transaction, input.sessionId)
          if (!current) {
            throw new ApplicationError('NOT_FOUND', 'Session was not found')
          }
          if (current.revision !== input.expectedRevision) {
            throw revisionConflict(current)
          }
          if (current.lifecycle === 'archived') {
            throw new ApplicationError(
              'CONFLICT',
              'Session is already archived',
            )
          }
          const timestamp = this.#now()
          const next: SessionRecord = {
            ...current,
            lifecycle: 'archived',
            archivedAt: timestamp,
            revision: current.revision + 1,
            updatedAt: timestamp,
          }
          if (!this.#sessions.update(transaction, next, current.revision)) {
            throw revisionConflict(current)
          }
          return { session: next, messageChange: { mode: 'none' as const } }
        },
      )
    } catch (error) {
      if (operationToken) {
        this.#runtimeGuard?.cancelSessionEviction?.(
          input.sessionId,
          operationToken,
        )
      }
      throw error
    }
    try {
      await this.#runtimeGuard?.releaseSession(input.sessionId, operationToken)
    } catch (error) {
      this.#onDiagnostic(
        `Archived Session ${input.sessionId} could not release its runtime context`,
        error,
      )
    }
    return result
  }

  /** Rebuilds a Session's active branch through a selected boundary and commits the result. */
  async rewind(input: {
    sessionId: SessionId
    expectedRevision: number
    messageId: MessageId
    boundary: 'after_message' | 'before_message' | 'before_turn'
  }): Promise<SessionCommandResult> {
    const operationToken = this.#runtimeGuard?.reserveSessionEviction?.(
      input.sessionId,
    )
    let result: SessionCommandResult
    try {
      result = await this.#coordinator.command(
        'session.changed',
        (transaction) => {
          if (!operationToken) {
            this.#runtimeGuard?.assertSessionIdle(input.sessionId)
          }
          const current = this.#sessions.get(transaction, input.sessionId)
          if (!current) {
            throw new ApplicationError('NOT_FOUND', 'Session was not found')
          }
          if (current.revision !== input.expectedRevision) {
            throw revisionConflict(current)
          }
          if (current.lifecycle !== 'active') {
            throw new ApplicationError(
              'PRECONDITION_FAILED',
              'Archived Session cannot be rewound',
            )
          }
          const target = this.#messages.get(
            transaction,
            input.sessionId,
            input.messageId,
          )
          if (
            !target ||
            target.visibility !== 'visible' ||
            (target.kind !== 'user_input' && target.kind !== 'assistant_turn')
          ) {
            throw new ApplicationError(
              'PRECONDITION_FAILED',
              'Rewind target must be a visible user or assistant message',
            )
          }
          if (
            (input.boundary === 'after_message' ||
              input.boundary === 'before_turn') &&
            (target.kind !== 'user_input' ||
              !('clientRequestId' in target) ||
              isControlCommandUserInput(target))
          ) {
            throw new ApplicationError(
              'PRECONDITION_FAILED',
              `${input.boundary} requires a visible original user message`,
            )
          }

          const records = this.#messages.listAll(transaction, input.sessionId)
          const boundarySeq = rewindBoundarySeq(records, target, input.boundary)
          for (const record of records) {
            if (record.seq > boundarySeq) {
              record.visibility = 'superseded'
              record.inHistory = false
            }
          }
          rebuildActiveBranch(records, boundarySeq)
          const active = records.filter((record) => record.inHistory)
          if (active.length > 0) {
            new MessageHistoryCompiler().compile(active)
          }
          for (const record of records) {
            this.#messages.updateBranchState(transaction, record)
          }

          const next: SessionRecord = {
            ...current,
            goal: null,
            plan: null,
            revision: current.revision + 1,
            updatedAt: this.#now(),
          }
          if (!this.#sessions.update(transaction, next, current.revision)) {
            throw revisionConflict(current)
          }
          return {
            session: next,
            messageChange: { mode: 'invalidate_all' as const },
          }
        },
      )
    } catch (error) {
      if (operationToken) {
        this.#runtimeGuard?.cancelSessionEviction?.(
          input.sessionId,
          operationToken,
        )
      }
      throw error
    }
    try {
      await this.#runtimeGuard?.releaseSession(input.sessionId, operationToken)
    } catch (error) {
      this.#onDiagnostic(
        `Rewound Session ${input.sessionId} could not release its runtime context`,
        error,
      )
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Session was rewound but its runtime context could not be reset',
        { details: { mutationSucceeded: true } },
      )
    }
    return result
  }

  /** Creates a new Session branch from a source Session through an optional message. */
  async fork(input: {
    sourceSessionId: SessionId
    expectedRevision: number
    sessionId: SessionId
    throughMessageId?: MessageId
    title?: string
  }): Promise<SessionCommandResult> {
    return this.#coordinator.command('session.changed', (transaction) => {
      this.#runtimeGuard?.assertSessionIdle(input.sourceSessionId)
      const source = this.#sessions.get(transaction, input.sourceSessionId)
      if (!source) {
        throw new ApplicationError('NOT_FOUND', 'Source Session was not found')
      }
      if (source.revision !== input.expectedRevision) {
        throw revisionConflict(source)
      }
      if (this.#sessions.get(transaction, input.sessionId)) {
        throw new ApplicationError(
          'CONFLICT',
          'Candidate fork Session id already exists',
        )
      }

      let throughSeq = source.lastSeq
      if (input.throughMessageId) {
        const point = this.#messages.get(
          transaction,
          source.id,
          input.throughMessageId,
        )
        if (!point) {
          throw new ApplicationError('NOT_FOUND', 'Fork point was not found')
        }
        if (
          point.visibility !== 'visible' ||
          (point.kind !== 'assistant_turn' &&
            !(
              point.kind === 'user_input' &&
              'clientRequestId' in point &&
              !isControlCommandUserInput(point)
            ))
        ) {
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Fork point must be an original user or assistant message',
          )
        }
        throughSeq = point.seq
      } else {
        const currentBranch = this.#messages
          .listAll(transaction, source.id)
          .filter((record) => record.visibility !== 'superseded')
        throughSeq = currentBranch.at(-1)?.seq ?? 0
      }

      let prefix = this.#messages
        .listAll(transaction, source.id)
        .filter(
          (record) =>
            record.seq <= throughSeq && record.visibility !== 'superseded',
        )
      if (prefix.length > MAX_FORK_MESSAGE_RECORDS) {
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          `A Session fork can copy at most ${MAX_FORK_MESSAGE_RECORDS} messages`,
        )
      }
      const point = prefix.at(-1)
      if (
        point?.kind === 'assistant_turn' &&
        point.parts.some((part) => part.type === 'tool_call')
      ) {
        const completePrefix = this.#messages
          .listAll(transaction, source.id)
          .filter((record) => record.visibility !== 'superseded')
        const expandedThrough = terminalToolBatchEnd(completePrefix, point.seq)
        prefix = completePrefix.filter(
          (record) => record.seq <= expandedThrough,
        )
        throughSeq = expandedThrough
      }
      if (prefix.length > MAX_FORK_MESSAGE_RECORDS) {
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          `A Session fork can copy at most ${MAX_FORK_MESSAGE_RECORDS} messages`,
        )
      }
      if (prefix.length === 0) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Fork history is incomplete',
        )
      }

      const idMap = new Map<MessageId, MessageId>()
      for (const record of prefix) {
        idMap.set(record.id, this.#createMessageId())
      }
      const seqMap = new Map<number, number>()
      prefix.forEach((record, index) => seqMap.set(record.seq, index + 1))
      const records = prefix.map((record, index) =>
        cloneForkMessage(record, input.sessionId, idMap, seqMap, index + 1),
      )
      rebuildActiveBranch(records, records.at(-1)?.seq ?? 0)
      new MessageHistoryCompiler().compile(
        records.filter((record) => record.inHistory),
      )
      const timestamp = this.#now()
      const isLatest = throughSeq === source.lastSeq
      const fork: SessionRecord = {
        schemaVersion: 1,
        id: input.sessionId,
        projectId: source.projectId,
        title: input.title?.trim() || `Fork: ${source.title}`,
        lifecycle: 'active',
        permissionMode: source.permissionMode,
        modelSelection: structuredClone(source.modelSelection),
        goal: isLatest ? structuredClone(source.goal) : null,
        plan: isLatest ? structuredClone(source.plan) : null,
        parent: {
          sessionId: source.id,
          forkedFromSeq: throughSeq,
        },
        revision: 1,
        lastSeq: records.at(-1)?.seq ?? 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.#sessions.insert(transaction, fork)
      this.#messages.insertMany(transaction, records)
      return {
        session: fork,
        messageChange: { mode: 'upsert' as const, records },
      }
    })
  }
}

function originalUserMessage(
  record: MessageRecord,
): Extract<MessageRecord, { kind: 'user_input' }> {
  if (record.kind !== 'user_input' || !('clientRequestId' in record)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'clientRequestId does not identify an original user message',
    )
  }
  return record
}

function assertNewSessionBatch(
  session: SessionRecord,
  messages: readonly MessageRecord[],
): void {
  if (
    session.revision !== 1 ||
    session.lifecycle !== 'active' ||
    messages.length === 0 ||
    session.lastSeq !== messages.length
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'First-turn Session batch is invalid',
    )
  }
  let seq = 0
  let originalUsers = 0
  for (const record of messages) {
    seq += 1
    if (record.sessionId !== session.id || record.seq !== seq) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'First-turn messages must be a contiguous Session-local sequence',
      )
    }
    if (record.kind === 'user_input' && 'clientRequestId' in record) {
      originalUsers += 1
    }
  }
  if (originalUsers !== 1) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'First-turn batch must contain exactly one original user message',
    )
  }
}

function assertSessionRevision(
  current: SessionRecord,
  expectedRevision: number,
  expectedLastSeq: number,
): void {
  if (
    current.revision !== expectedRevision ||
    current.lastSeq !== expectedLastSeq
  ) {
    throw revisionConflict(current)
  }
}

function assertAppendBatch(
  current: SessionRecord,
  records: readonly MessageRecord[],
): void {
  let expectedSeq = current.lastSeq + 1
  for (const record of records) {
    if (
      record.sessionId !== current.id ||
      record.seq !== expectedSeq ||
      (!record.inHistory && !isControlCommandUserInput(record))
    ) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Message append batch must be contiguous and Provider-active unless it is a control command',
      )
    }
    expectedSeq += 1
  }
}

function applyMetadata(
  session: SessionRecord,
  patch: SessionMetadataPatch | undefined,
): SessionRecord {
  if (!patch) return session
  return {
    ...session,
    ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
    ...(patch.permissionMode === undefined
      ? {}
      : { permissionMode: patch.permissionMode }),
    ...(patch.modelSelection === undefined
      ? {}
      : { modelSelection: structuredClone(patch.modelSelection) }),
    ...(patch.goal === undefined ? {} : { goal: structuredClone(patch.goal) }),
    ...(patch.plan === undefined ? {} : { plan: structuredClone(patch.plan) }),
  }
}

function mutationMessageChange(
  input: SessionMutation,
  records: MessageRecord[],
): SessionMessageChange {
  if (input.messageChange === 'invalidate') {
    if (input.deactivateThroughSeq === undefined) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Invalidate commit requires a compact boundary',
      )
    }
    return {
      mode: 'invalidate',
      throughSeq: input.deactivateThroughSeq,
    }
  }
  if (input.messageChange === 'invalidate_all') {
    return { mode: 'invalidate_all' }
  }
  if (records.length > 0) return { mode: 'upsert', records }
  return { mode: 'none' }
}

function revisionConflict(current: SessionRecord): ApplicationError {
  return new ApplicationError('CONFLICT', 'Session revision has changed', {
    details: {
      currentRevision: current.revision,
      currentLastSeq: current.lastSeq,
    },
  })
}

function boundedSnippet(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.slice(0, 512) || '…'
}
