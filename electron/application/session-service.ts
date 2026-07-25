import { randomUUID } from 'node:crypto'
import type { PermissionMode } from '../../shared/config'
import { MAX_FORK_MESSAGE_RECORDS } from '../../shared/durable'
import type {
  SessionCommandResult,
  SessionMessageChange,
} from '../../shared/domain-state-api'
import type { MessageId, SessionId } from '../../shared/ids'
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

export interface SessionRuntimeGuard {
  assertSessionIdle(sessionId: SessionId): void
  snapshot(sessionId: SessionId): ActiveRunPublicSnapshot | undefined
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
    return runtime ? { ...snapshot, runtime } : snapshot
  }

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
          point.kind !== 'assistant_turn' &&
          !(
            point.kind === 'user_input' &&
            'clientRequestId' in point &&
            !isControlCommandUserInput(point)
          )
        ) {
          throw new ApplicationError(
            'PRECONDITION_FAILED',
            'Fork point must be an original user or assistant message',
          )
        }
        throughSeq = point.seq
      }

      let prefix = this.#messages.listThrough(
        transaction,
        source.id,
        throughSeq,
        MAX_FORK_MESSAGE_RECORDS + 1,
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
        const completePrefix = this.#messages.listThrough(
          transaction,
          source.id,
          source.lastSeq,
          MAX_FORK_MESSAGE_RECORDS + 1,
        )
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
      if (prefix.length !== throughSeq || prefix.length === 0) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Fork history is incomplete',
        )
      }

      const idMap = new Map<MessageId, MessageId>()
      for (const record of prefix) {
        idMap.set(record.id, this.#createMessageId())
      }
      const latestCompact = [...prefix]
        .reverse()
        .find((record) => record.kind === 'compact_summary')
      const activeBoundary =
        latestCompact?.kind === 'compact_summary'
          ? latestCompact.metadata.compact.replacesThroughSeq
          : 0
      const records = prefix.map((record) =>
        cloneForkMessage(
          record,
          input.sessionId,
          idMap,
          record.seq > activeBoundary && !isControlCommandUserInput(record),
        ),
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

function terminalToolBatchEnd(
  records: readonly MessageRecord[],
  assistantSeq: number,
): number {
  const assistant = records.find((record) => record.seq === assistantSeq)
  if (assistant?.kind !== 'assistant_turn') return assistantSeq
  const pending = assistant.parts.flatMap((part) =>
    part.type === 'tool_call' ? [part.callId] : [],
  )
  if (pending.length === 0) return assistantSeq
  let cursor = assistantSeq
  for (const callId of pending) {
    cursor += 1
    const result = records.find((record) => record.seq === cursor)
    if (result?.kind !== 'tool_result' || result.parts[0].callId !== callId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork point assistant does not have a complete terminal tool batch',
      )
    }
  }
  return cursor
}

function cloneForkMessage(
  source: MessageRecord,
  sessionId: SessionId,
  idMap: ReadonlyMap<MessageId, MessageId>,
  inHistory: boolean,
): MessageRecord {
  const record = structuredClone(source)
  const id = idMap.get(source.id)
  if (!id) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Fork message id map is incomplete',
    )
  }
  const clone = {
    ...record,
    id,
    sessionId,
    inHistory,
  }
  if (
    clone.kind === 'user_input' &&
    clone.metadata &&
    'replayedFromMessageId' in clone.metadata
  ) {
    const replayedFromMessageId = idMap.get(
      clone.metadata.replayedFromMessageId,
    )
    if (!replayedFromMessageId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork replay reference leaves the copied Session',
      )
    }
    return {
      ...clone,
      metadata: {
        ...clone.metadata,
        replayedFromMessageId,
      },
    }
  }
  if (
    clone.kind === 'user_input' &&
    clone.metadata &&
    'derivedFromMessageId' in clone.metadata
  ) {
    const derivedFromMessageId = idMap.get(clone.metadata.derivedFromMessageId)
    if (!derivedFromMessageId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork derived reference leaves the copied Session',
      )
    }
    return {
      ...clone,
      metadata: {
        ...clone.metadata,
        derivedFromMessageId,
      },
    }
  }
  return clone
}
