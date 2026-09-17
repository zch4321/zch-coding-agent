import { SubagentCaptures } from './captures'
import { SubagentConversations, type ParentAgentMessage } from './conversations'
import { resolveRunRoutes } from '../providers/model-route-resolver'
import { renderTaggedText } from '../../shared/tagged-message'
import { agentSessionMetadata } from './session-metadata'
import { executeSubagentWorker, type ActiveSubagentWorker } from './worker'
import type { AgentExecutionStatus } from '../../shared/agent-execution'
import {
  specHash,
  json,
  normalizeSpec,
  completedResult,
} from './execution-validation'
import {
  artifactCaptureAvailable,
  artifactPathFor,
} from '../project-artifacts/access'
import { randomUUID } from 'node:crypto'
import { accessPath as access } from '../common/filesystem'
import path from 'node:path'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import type { SessionManager } from '../session/session-manager'
import type { SessionService } from '../application/session-service'
import {
  SubagentCapacityError,
  type SubagentStateService,
} from '../application/subagent-state-service'
import type { DurableExecutionStatePort } from '../application/durable-execution-state-port'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import { projectAgentExecutionSummary } from './public-projection'
import {
  SubagentRuntimeError,
  type BackgroundTaskHandle,
  type FrozenSubagentToolContext,
  type FrozenSubagentRoutes,
  type PreparedSubagentExecution,
  type PreparedSubagentExecutionPort,
  type SubagentParentContext,
  type SubagentRunResult,
  type SubagentSpec,
} from './contracts'
import type { SessionTempPaths } from '../session-temp/service'
import type { BackgroundAgentHandleRegistry } from '../background/agent-handle-registry'
import type { SubagentArtifacts } from './execution-artifacts'

interface StartedExecution {
  handle: BackgroundTaskHandle
  promise: Promise<SubagentRunResult>
}

interface StartingExecution {
  specHash: string
  promise: Promise<StartedExecution>
}

/** Owns the hidden Session, timeout, idempotency, and cleanup for one child. */
export class SubagentExecutionService implements PreparedSubagentExecutionPort {
  readonly #configStore: ConfigStore
  readonly #manager: SessionManager
  readonly #sessions: SessionService
  readonly #executionState: DurableExecutionStatePort
  readonly #state: SubagentStateService
  readonly #events: RuntimeEventSink
  readonly #handles: BackgroundAgentHandleRegistry
  readonly #onDiagnostic: DiagnosticSink
  readonly #active = new Map<string, ActiveSubagentWorker>()
  readonly #identities = new Map<AgentExecutionId, SubagentExecutionRecord>()
  readonly #captures = new SubagentCaptures()
  readonly #starting = new Set<Promise<StartedExecution>>()
  readonly #startsByCall = new Map<string, StartingExecution>()
  readonly #cancelledBeforeLaunch = new Set<AgentExecutionId>()
  readonly #conversations: SubagentConversations
  #disposing = false

  constructor(options: {
    configStore: ConfigStore
    manager: SessionManager
    sessions: SessionService
    executionState: DurableExecutionStatePort
    state: SubagentStateService
    events: RuntimeEventSink
    handles: BackgroundAgentHandleRegistry
    onDiagnostic?: DiagnosticSink
  }) {
    this.#configStore = options.configStore
    this.#manager = options.manager
    this.#sessions = options.sessions
    this.#executionState = options.executionState
    this.#state = options.state
    this.#events = options.events
    this.#handles = options.handles
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.#conversations = new SubagentConversations({
      active: (sessionId) =>
        [...this.#active.values()].find(
          (worker) => worker.record.childSessionId === sessionId,
        ),
      inject: (sessionId, message) =>
        this.#manager.sendInternalMessage(
          sessionId,
          message.text,
          JSON.stringify([message.parent.runId, message.parent.callId]),
          { runId: message.parent.runId, callId: message.parent.callId },
        ),
      resume: (record) => {
        void this.resume(record.parentSessionId, record.id).catch((error) =>
          this.#onDiagnostic('Unable to resume child', error),
        )
      },
      launch: (record, message, wanted) =>
        this.#followup(record, message, wanted),
      failed: (error) =>
        this.#onDiagnostic('Unable to continue child conversation', error),
    })
  }

  /** Starts or idempotently reuses one detached execution and returns its handle. */
  async startOne(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<BackgroundTaskHandle> {
    const started = await this.#trackedStart(candidate, parent)
    void started.promise.catch(() => undefined)
    return started.handle
  }

  /** Compatibility facade that waits for one detached execution's final result. */
  async runOne(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<SubagentRunResult> {
    return (await this.#trackedStart(candidate, parent)).promise
  }

  #trackedStart(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<StartedExecution> {
    const normalized = normalizeSpec(candidate)
    const normalizedHash = specHash(normalized)
    const callKey = JSON.stringify([
      parent.sessionId,
      parent.runId,
      parent.callId,
    ])
    const existing = this.#startsByCall.get(callKey)
    if (existing) {
      return existing.specHash === normalizedHash
        ? existing.promise
        : Promise.reject(
            new SubagentRuntimeError(
              'SUBAGENT_CALL_CONFLICT',
              'The parent Tool call was already used with different arguments',
            ),
          )
    }
    const starting = this.#startStandalone(normalized, parent).finally(() => {
      this.#starting.delete(starting)
      if (this.#startsByCall.get(callKey)?.promise === starting) {
        this.#startsByCall.delete(callKey)
      }
    })
    this.#starting.add(starting)
    this.#startsByCall.set(callKey, {
      specHash: normalizedHash,
      promise: starting,
    })
    return starting
  }

  async #startStandalone(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<StartedExecution> {
    if (this.#disposing) {
      throw new SubagentRuntimeError(
        'SUBAGENT_RUNTIME_DISPOSING',
        'Subagent runtime is shutting down',
      )
    }
    const spec = normalizeSpec(candidate)
    const config = this.#configStore.getPublicConfig()
    const routes = this.#manager.frozenSubagentRoutes(
      parent.sessionId,
      parent.runId,
    )
    const toolContext = this.#manager.frozenSubagentToolContext(
      parent.sessionId,
      parent.runId,
      spec.toolAccess,
    )
    parent.signal.throwIfAborted()
    const timestamp = new Date().toISOString()
    const executionId = `subagent-${randomUUID()}` as AgentExecutionId
    const record: SubagentExecutionRecord = {
      id: executionId,
      childSessionId: `subagent-session-${randomUUID()}` as SessionId,
      kind: 'subagent',
      name: spec.name,
      parentSessionId: parent.sessionId,
      parentRunId: parent.runId,
      parentCallId: parent.callId,
      specHash: specHash(spec),
      status: 'preparing',
      route: json({
        schemaVersion: 1,
        main: routes.main.snapshot,
        compression: routes.compression.snapshot,
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    let reserved
    try {
      reserved = await this.#state.createExecution(
        record,
        parent.maxSubagents ?? config.subagents.maxSubagents,
        { metadata: agentSessionMetadata(record.id, toolContext) },
      )
    } catch (error) {
      if (error instanceof SubagentCapacityError) {
        throw new SubagentRuntimeError(error.capacityCode, error.message)
      }
      throw new SubagentRuntimeError(
        'SUBAGENT_START_FAILED',
        error instanceof Error
          ? error.message
          : 'Subagent durable reservation failed',
      )
    }
    if (!reserved.created) {
      if (reserved.record.specHash !== record.specHash) {
        throw new SubagentRuntimeError(
          'SUBAGENT_CALL_CONFLICT',
          'The parent Tool call was already used with different arguments',
        )
      }
      const active = this.#active.get(reserved.record.id)
      const handle = await this.#handleFor(reserved.record, parent.sessionTemp)
      if (active) return { handle, promise: active.promise }
      if (reserved.record.status === 'completed') {
        const result = completedResult(reserved.record, spec.name)
        if (result) return { handle, promise: Promise.resolve(result) }
        throw new SubagentRuntimeError(
          'SUBAGENT_RESULT_CORRUPT',
          'The persisted Subagent result is invalid',
        )
      }
      const failure = new SubagentRuntimeError(
        reserved.record.error?.code ?? 'SUBAGENT_ALREADY_FINALIZED',
        reserved.record.error?.message ??
          `Subagent execution is ${reserved.record.status}`,
      )
      return { handle, promise: Promise.reject(failure) }
    }
    this.#publishExecutionChanged(record, spec.name)
    const artifacts = await this.#captures.initialize(
      record,
      parent.sessionTemp,
    )
    const promise = this.#launch({
      spec,
      parent,
      routes,
      toolContext,
      record,
      workerTimeoutMs: config.subagents.workerTimeoutMs,
    })
    return {
      handle: this.#artifactHandle(record, artifacts),
      promise,
    }
  }

  /** Runs one atomically prepared Swarm child with its explicit frozen route. */
  async runPrepared(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
    prepared: PreparedSubagentExecution,
  ): Promise<SubagentRunResult> {
    if (this.#disposing) {
      throw new SubagentRuntimeError(
        'SUBAGENT_RUNTIME_DISPOSING',
        'Subagent runtime is shutting down',
      )
    }
    const spec = normalizeSpec(candidate)
    const config = this.#configStore.getPublicConfig()
    const record = await this.#state.getExecution(
      parent.sessionId,
      prepared.executionId,
    )
    if (
      !record ||
      record.kind !== 'subagent' ||
      record.parentExecutionId !== prepared.parentExecutionId ||
      record.childOrdinal !== prepared.childOrdinal ||
      record.parentRunId !== parent.runId ||
      record.parentCallId !== parent.callId ||
      record.specHash !== specHash(spec)
    ) {
      throw new SubagentRuntimeError(
        'SUBAGENT_PREPARED_EXECUTION_INVALID',
        'Prepared Subagent execution does not match its durable identity',
      )
    }
    const active = this.#active.get(record.id)
    if (active) return active.promise
    if (record.status === 'completed') {
      const result = completedResult(record, spec.name)
      if (result) return result
      throw new SubagentRuntimeError(
        'SUBAGENT_RESULT_CORRUPT',
        'The persisted Subagent result is invalid',
      )
    }
    if (record.status !== 'queued') {
      throw new SubagentRuntimeError(
        record.error?.code ?? 'SUBAGENT_ALREADY_FINALIZED',
        record.error?.message ?? `Subagent execution is ${record.status}`,
      )
    }
    await this.#captures.initialize(record, parent.sessionTemp)
    return this.#launch({
      spec,
      parent,
      routes: prepared.routes,
      toolContext:
        prepared.toolContext ??
        this.#manager.frozenSubagentToolContext(
          parent.sessionId,
          parent.runId,
          spec.toolAccess,
        ),
      record,
      workerTimeoutMs: config.subagents.workerTimeoutMs,
      cancellationSignal: prepared.cancellationSignal,
    })
  }

  #launch(input: {
    spec: SubagentSpec
    parent: SubagentParentContext
    routes: FrozenSubagentRoutes
    toolContext: FrozenSubagentToolContext
    record: SubagentExecutionRecord
    workerTimeoutMs: number
    cancellationSignal?: AbortSignal
    parentMessage?: boolean
  }): Promise<SubagentRunResult> {
    const controller = new AbortController()
    const timeoutReason = new SubagentRuntimeError(
      'SUBAGENT_TIMEOUT',
      'Subagent worker exceeded its configured timeout',
    )
    const cancel = () =>
      controller.abort(
        input.cancellationSignal?.reason ??
          new SubagentRuntimeError(
            'SUBAGENT_CANCELLED',
            'Subagent execution was cancelled',
          ),
      )
    if (input.cancellationSignal?.aborted) cancel()
    else
      input.cancellationSignal?.addEventListener('abort', cancel, {
        once: true,
      })
    if (this.#cancelledBeforeLaunch.delete(input.record.id)) {
      controller.abort(
        new SubagentRuntimeError(
          'SUBAGENT_CANCELLED',
          `Subagent ${input.record.id} was cancelled`,
        ),
      )
    }
    let settle!: (
      value: SubagentRunResult | PromiseLike<SubagentRunResult>,
    ) => void
    let reject!: (error: unknown) => void
    const settlement = new Promise<SubagentRunResult>((resolve, fail) => {
      settle = resolve
      reject = fail
    })
    const active: ActiveSubagentWorker = {
      controller,
      promise: settlement,
      parentSessionId: input.record.parentSessionId,
      record: input.record,
    }
    if (!this.#identities.has(input.record.id))
      this.#identities.set(input.record.id, { ...input.record })
    this.#active.set(input.record.id, active)
    const promise = executeSubagentWorker({
      onCarryover: (messages) =>
        this.#conversations.carry(input.record, input.parent, messages),
      active,
      manager: this.#manager,
      sessions: this.#sessions,
      executionState: this.#executionState,
      state: this.#state,
      onDiagnostic: this.#onDiagnostic,
      publish: (record, name) => this.#publishExecutionChanged(record, name),
      appendActivity: (record, value) => this.#captures.append(record, value),
      writeResult: (record, temp, response) =>
        this.#captures.writeResult(record, temp, response),
      artifacts: () => this.#captures.get(input.record.id),
      ...input,
      controller,
      timeoutReason,
    }).finally(async () => {
      input.cancellationSignal?.removeEventListener('abort', cancel)
      await this.#captures.finish(input.record.id)
      this.#active.delete(input.record.id)
    })
    void promise.then(settle, reject)
    return settlement
  }

  #publishExecutionChanged(
    record: SubagentExecutionRecord,
    name: string,
  ): void {
    const identity = this.#identities.get(record.id) ?? record
    const pending = this.#conversations.pending(record.childSessionId)
    this.#events.publishAgentExecution({
      type: 'execution.changed',
      executionId: identity.id,
      parentSessionId: record.parentSessionId,
      parentRunId: record.parentRunId,
      parentCallId: record.parentCallId,
      summary: {
        ...projectAgentExecutionSummary(
          {
            ...record,
            id: identity.id,
            createdAt: identity.createdAt,
            parentExecutionId: identity.parentExecutionId,
            childOrdinal: identity.childOrdinal,
          },
          { name },
        ),
        status:
          pending && !['queued', 'preparing', 'running'].includes(record.status)
            ? 'queued'
            : (this.runtimeStatus(record.id) ?? record.status),
        stopRequested: this.isStopRequested(record.id),
      },
    })
  }

  #artifactHandle(
    record: SubagentExecutionRecord,
    artifacts: SubagentArtifacts,
  ): BackgroundTaskHandle {
    return {
      target: this.#targetFor(record),
      status: record.status,
      artifactAvailable: artifacts.available,
      ...(artifacts.available ? { artifactPath: artifacts.directory } : {}),
      ...(artifacts.captureError
        ? { captureError: artifacts.captureError }
        : {}),
    }
  }

  async #handleFor(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<BackgroundTaskHandle> {
    const activeArtifacts = this.#captures.get(record.id)
    if (activeArtifacts) return this.#artifactHandle(record, activeArtifacts)
    if (!sessionTemp) {
      return {
        target: this.#targetFor(record),
        status: record.status,
        artifactAvailable: false,
        captureError: 'Session temp is unavailable',
      }
    }
    const directory = await artifactPathFor(
      sessionTemp,
      ['subagents', record.id],
      false,
    )
    try {
      if (!artifactCaptureAvailable(sessionTemp, ['subagents', record.id]))
        throw new Error('Capture unavailable or expired')
      await access(path.join(directory, 'activity.jsonl'))
      return {
        target: this.#targetFor(record),
        status: record.status,
        artifactAvailable: true,
        artifactPath: directory,
      }
    } catch {
      return {
        target: this.#targetFor(record),
        status: record.status,
        artifactAvailable: false,
      }
    }
  }

  #targetFor(record: SubagentExecutionRecord): BackgroundTaskHandle['target'] {
    return {
      type: 'subagent',
      id: this.#handles.expose({
        executionId: record.id,
        childSessionId: record.childSessionId,
        parentSessionId: record.parentSessionId,
        type: 'subagent',
      }),
    }
  }

  /** Resolves any historical execution handle to the current execution of its child Session. */
  async currentExecution(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<SubagentExecutionRecord | undefined> {
    const owned = await this.#state.getExecution(parentSessionId, executionId)
    return owned?.childSessionId
      ? ((await this.#state.latestExecution(
          parentSessionId,
          owned.childSessionId,
        )) ?? owned)
      : owned
  }

  /** Reports accepted input while a completed worker is handing off to its successor. */
  pendingMessages(
    record: Pick<SubagentExecutionRecord, 'childSessionId'>,
  ): number {
    return this.#conversations.pending(record.childSessionId)
  }

  /** Admits a text message under the original delegation ceiling and serializes duplicate tool calls. */
  async sendMessage(
    executionId: AgentExecutionId,
    text: string,
    parent: SubagentParentContext,
  ): Promise<void> {
    if (this.#disposing)
      throw new SubagentRuntimeError(
        'SUBAGENT_UNAVAILABLE',
        'Runtime is shutting down',
      )
    this.#manager.frozenSubagentRoutes(parent.sessionId, parent.runId)
    const record = await this.currentExecution(parent.sessionId, executionId)
    if (!record?.childSessionId || record.kind !== 'subagent')
      throw new SubagentRuntimeError(
        'SUBAGENT_NOT_FOUND',
        'Child agent was not found',
      )
    const identity = await this.#state.childIdentity(
      parent.sessionId,
      record.childSessionId,
    )
    if (!identity?.metadata.delegation)
      throw new SubagentRuntimeError(
        'SUBAGENT_HISTORY_ONLY',
        'This older child has no saved delegation',
      )
    const message = text.trim()
    if (!message || message.length > 32768)
      throw new SubagentRuntimeError(
        'SUBAGENT_MESSAGE_INVALID',
        'Message must contain 1–32768 characters',
      )
    await this.#conversations.control(
      record,
      parent,
      JSON.stringify(['send', message]),
      async () => this.#conversations.send(record, { text: message, parent }),
    )
    this.#publishExecutionChanged(record, record.name)
  }

  async #followup(
    previous: SubagentExecutionRecord,
    message: ParentAgentMessage,
    wanted: () => boolean,
  ): Promise<void> {
    if (this.#disposing || !wanted()) return
    const identity = await this.#state.childIdentity(
      previous.parentSessionId,
      previous.childSessionId!,
    )
    if (!identity?.metadata.delegation)
      throw new Error('Child delegation is unavailable')
    const routes = await resolveRunRoutes(
      this.#configStore,
      identity.record.modelSelection,
    )
    const delegation = identity.metadata.delegation
    const toolContext: FrozenSubagentToolContext = {
      ...delegation,
      allowedToolIds: new Set(delegation.allowedToolIds),
    }
    const now = new Date().toISOString()
    const record: SubagentExecutionRecord = {
      id: `subagent-${randomUUID()}` as AgentExecutionId,
      childSessionId: previous.childSessionId,
      kind: 'subagent',
      name: previous.name,
      parentSessionId: previous.parentSessionId,
      parentRunId: message.parent.runId,
      parentCallId: message.parent.callId,
      specHash: specHash({
        name: previous.name,
        task: message.text,
        toolAccess: 'inherit',
      }),
      status: 'queued',
      route: json({
        schemaVersion: 1,
        main: routes.main.snapshot,
        compression: routes.compression.snapshot,
      }),
      createdAt: now,
      updatedAt: now,
    }
    if (!wanted()) return
    const config = this.#configStore.getPublicConfig()
    const reserved = await this.#state.createExecution(
      record,
      config.subagents.maxSubagents,
      { waitForCapacity: true },
    )
    if (!reserved.created || this.#disposing) return
    const original = await this.#state.getExecution(
      previous.parentSessionId,
      identity.metadata.initialExecutionId,
    )
    if (original) this.#identities.set(record.id, original)
    await this.#captures.initialize(record, message.parent.sessionTemp)
    if (!wanted() || this.#disposing) {
      record.status = 'cancelled'
      record.completedAt = new Date().toISOString()
      record.updatedAt = record.completedAt
      await this.#state.updateExecution(record)
      return
    }
    this.#targetFor(record)
    const promise = this.#launch({
      spec: {
        name: record.name,
        task: renderTaggedText('parent_agent_message', message.text),
        toolAccess: 'inherit',
      },
      parent: message.parent,
      routes,
      toolContext,
      record,
      workerTimeoutMs: config.subagents.workerTimeoutMs,
      parentMessage: true,
    })
    void promise.catch(() => undefined)
    this.#publishExecutionChanged(record, record.name)
  }

  /** Returns the ephemeral pause projection without persisting a suspended Run. */
  runtimeStatus(
    executionId: AgentExecutionId,
  ): AgentExecutionStatus | undefined {
    const active =
      this.#active.get(executionId) ??
      [...this.#active.values()].find(
        (worker) => this.#identities.get(worker.record.id)?.id === executionId,
      )
    const identity = this.#identities.get(executionId)
    if (!active && this.#conversations.pending(identity?.childSessionId))
      return 'queued'
    if (
      !active ||
      active.controller.signal.aborted ||
      !['queued', 'preparing', 'running'].includes(active.record.status)
    )
      return undefined
    const snapshot = active.childSessionId
      ? this.#manager.activeRunSnapshot(active.childSessionId)
      : undefined
    if (snapshot?.status === 'paused') return 'paused'
    if (active.pauseReason || snapshot?.pauseRequested) return 'pausing'
    return undefined
  }

  /** Requests a safe pause on one owned active worker. */
  async pause(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    executionId =
      (await this.currentExecution(parentSessionId, executionId))?.id ??
      executionId
    const active = this.#active.get(executionId)
    if (
      !active ||
      active.parentSessionId !== parentSessionId ||
      active.controller.signal.aborted
    )
      return false
    active.pauseReason ??= 'requested'
    if (active.childSessionId && active.runId)
      this.#manager.pauseRun(
        active.childSessionId,
        active.runId,
        active.pauseReason,
      )
    this.#publishExecutionChanged(active.record, active.record.name)
    return true
  }

  /** Continues a paused worker while retaining its original Run and commands. */
  async resume(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    const active = this.#active.get(executionId)
    if (
      !active ||
      active.parentSessionId !== parentSessionId ||
      active.controller.signal.aborted
    )
      return false
    if (!active.pauseReason) return true
    active.resumePromise ??= this.#state.capacity
      .acquire(
        parentSessionId,
        active.record.id,
        this.#configStore.getPublicConfig().subagents.maxSubagents,
        active.controller.signal,
      )
      .then(() => {
        active.controller.signal.throwIfAborted()
        delete active.pauseReason
        active.deadline?.reset()
        if (active.childSessionId && active.runId)
          this.#manager.resumePausedRun(active.childSessionId, active.runId)
        this.#publishExecutionChanged(active.record, active.record.name)
        return true
      })
      .finally(() => {
        delete active.resumePromise
      })
    void active.resumePromise.catch(() => undefined)
    return true
  }

  /** Reports cancellation intent while an execution still owns its cleanup. */
  isStopRequested(executionId: AgentExecutionId): boolean {
    return (
      (
        this.#active.get(executionId) ??
        [...this.#active.values()].find(
          (worker) =>
            this.#identities.get(worker.record.id)?.id === executionId,
        )
      )?.controller.signal.aborted === true ||
      this.#cancelledBeforeLaunch.has(executionId)
    )
  }

  /** Cancels one active or durably queued child and closes only its own terminals. */
  async cancel(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    const current = await this.currentExecution(parentSessionId, executionId)
    if (current) {
      executionId = current.id
      this.#conversations.cancel(current.childSessionId)
    }
    let active = this.#active.get(executionId)
    const owned =
      active?.parentSessionId === parentSessionId
        ? active.record
        : await this.#state.getExecution(parentSessionId, executionId)
    if (!owned || owned.kind !== 'subagent') return false
    const childSessionId =
      active?.parentSessionId === parentSessionId && active.childSessionId
        ? active.childSessionId
        : await this.#state.getChildSessionId(parentSessionId, executionId)
    active = this.#active.get(executionId)
    if (active?.parentSessionId === parentSessionId) {
      active.controller.abort(
        new SubagentRuntimeError(
          'SUBAGENT_CANCELLED',
          `Subagent ${executionId} was cancelled`,
        ),
      )
      if (childSessionId)
        this.#manager
          .backgroundTerminalPool()
          .closeSession(childSessionId, true)
      this.#publishExecutionChanged(active.record, active.record.name)
      return true
    }
    if (childSessionId)
      this.#manager.backgroundTerminalPool().closeSession(childSessionId, true)
    const record = await this.#state.getExecution(parentSessionId, executionId)
    if (
      !record ||
      (record.status !== 'queued' &&
        record.status !== 'preparing' &&
        record.status !== 'running')
    ) {
      return false
    }
    const racedActive = this.#active.get(executionId)
    if (racedActive?.parentSessionId === parentSessionId) {
      racedActive.controller.abort(
        new SubagentRuntimeError(
          'SUBAGENT_CANCELLED',
          `Subagent ${executionId} was cancelled`,
        ),
      )
      if (racedActive.childSessionId)
        this.#manager
          .backgroundTerminalPool()
          .closeSession(racedActive.childSessionId, true)
      this.#publishExecutionChanged(racedActive.record, racedActive.record.name)
      return true
    }
    this.#cancelledBeforeLaunch.add(executionId)
    const completedAt = new Date().toISOString()
    record.status = 'cancelled'
    record.error = {
      code: 'SUBAGENT_CANCELLED',
      message: `Subagent ${executionId} was cancelled`,
    }
    record.updatedAt = completedAt
    record.completedAt = completedAt
    await this.#state.updateExecution(record)
    // A pending launch or its Swarm coordinator still owns the capture writers.
    this.#publishExecutionChanged(record, record.name)
    return true
  }

  /** Waits for an owned child's worker and terminal cleanup after a cancellation request. */
  async waitForSettlement(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<void> {
    const active = this.#active.get(executionId)
    if (active?.parentSessionId === parentSessionId)
      await active.promise.catch(() => undefined)
    const sessionId = await this.#state.getChildSessionId(
      parentSessionId,
      executionId,
    )
    if (sessionId)
      await this.#manager.backgroundTerminalPool().waitForSessionExit(sessionId)
  }

  /** Returns current capture truth without treating artifact files as authority. */
  artifactStatus(
    executionId: AgentExecutionId,
  ): import('./contracts').BackgroundArtifactStatus | undefined {
    const artifacts = this.#captures.get(executionId)
    if (!artifacts) return undefined
    return {
      artifactAvailable: artifacts.available,
      ...(artifacts.available ? { artifactPath: artifacts.directory } : {}),
      ...(artifacts.captureError
        ? { captureError: artifacts.captureError }
        : {}),
    }
  }

  /** Cancels all queued/preparing/running children and waits for their cleanup. */
  async dispose(): Promise<void> {
    this.#disposing = true
    this.#conversations.close()
    await Promise.allSettled([...this.#starting])
    const active = [...this.#active.values()]
    for (const execution of active) {
      execution.controller.abort(
        new SubagentRuntimeError(
          'SUBAGENT_RUNTIME_DISPOSING',
          'Subagent runtime is shutting down',
        ),
      )
    }
    await Promise.allSettled(active.map((execution) => execution.promise))
    await this.#conversations.settled()
  }
}
