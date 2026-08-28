import { createHash, randomUUID } from 'node:crypto'
import { access, appendFile } from 'node:fs/promises'
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
import type { SessionRecord } from '../../shared/session'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { LlmUsageRecord } from '../../shared/usage'
import { MAX_SWARM_SHARED_CONTEXT_LENGTH } from '../../shared/swarm'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import { projectAgentExecutionSummary } from './public-projection'
import {
  swarmSharedContextContent,
  swarmTaskContent,
} from './assignment-prompt'
import {
  SubagentRuntimeError,
  type BackgroundTaskHandle,
  summarizeSubagentUsage,
  type FrozenSubagentToolContext,
  type FrozenSubagentRoutes,
  type PreparedSubagentExecution,
  type PreparedSubagentExecutionPort,
  type SubagentParentContext,
  type SubagentRunResult,
  type SubagentSpec,
} from './contracts'
import {
  touchSessionTempPath,
  writeSessionArtifactText,
  type SessionTempPaths,
} from '../session-temp/service'

const MAX_ERROR_LENGTH = 65_536
const OUTPUT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'model_length',
])
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

interface ActiveExecution {
  controller: AbortController
  promise: Promise<SubagentRunResult>
  parentSessionId: SessionId
}

interface StartedExecution {
  handle: BackgroundTaskHandle
  promise: Promise<SubagentRunResult>
}

interface StartingExecution {
  specHash: string
  promise: Promise<StartedExecution>
}

interface SubagentArtifacts {
  directory: string
  activityPath: string
  resultPath: string
  sessionTemp?: SessionTempPaths
  available: boolean
  captureError?: string
  tail: Promise<void>
}

function specHash(spec: SubagentSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function normalizeSpec(spec: SubagentSpec): SubagentSpec {
  const name = spec.name.trim()
  const task = spec.task.trim()
  const sharedContext = spec.sharedContext?.trim()
  if (
    name.length < 1 ||
    [...name].length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(name) ||
    RESERVED_NAMES.has(name)
  ) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_NAME',
      'Subagent name must be a safe 1-64 character value',
    )
  }
  if (task.length < 1 || [...task].length > 32_768) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_TASK',
      'Subagent task must contain 1-32768 characters',
    )
  }
  if (spec.toolAccess !== 'readonly' && spec.toolAccess !== 'inherit') {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_TOOL_ACCESS',
      'Subagent toolAccess must be readonly or inherit',
    )
  }
  if (
    spec.sharedContext !== undefined &&
    (!sharedContext ||
      [...sharedContext].length > MAX_SWARM_SHARED_CONTEXT_LENGTH)
  ) {
    throw new SubagentRuntimeError(
      'INVALID_SUBAGENT_SHARED_CONTEXT',
      `Subagent shared context must contain 1-${MAX_SWARM_SHARED_CONTEXT_LENGTH} characters`,
    )
  }
  return {
    name,
    task,
    toolAccess: spec.toolAccess,
    ...(sharedContext ? { sharedContext } : {}),
  }
}

function completedResult(
  record: SubagentExecutionRecord,
  expectedName: string,
): SubagentRunResult | undefined {
  const value = record.result
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const results = value.results
  const meta = value.meta
  if (
    !results ||
    typeof results !== 'object' ||
    Array.isArray(results) ||
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta)
  ) {
    return undefined
  }
  const entries = Object.entries(results)
  const usage = Reflect.get(meta, 'usage')
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== expectedName ||
    entries.some(
      ([name, result]) =>
        RESERVED_NAMES.has(name) || typeof result !== 'string',
    ) ||
    typeof Reflect.get(meta, 'durationMs') !== 'number' ||
    !Number.isFinite(Reflect.get(meta, 'durationMs')) ||
    typeof Reflect.get(meta, 'providerId') !== 'string' ||
    typeof Reflect.get(meta, 'model') !== 'string' ||
    typeof Reflect.get(meta, 'truncated') !== 'boolean' ||
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage)
  ) {
    return undefined
  }
  const usageFields = [
    'records',
    'promptTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
    'cacheHitTokens',
    'cacheMissTokens',
  ] as const
  if (
    usageFields.some((field) => {
      const count = Reflect.get(usage, field)
      return !Number.isSafeInteger(count) || Number(count) < 0
    })
  ) {
    return undefined
  }
  return {
    results: Object.fromEntries(entries) as Record<string, string>,
    meta: {
      durationMs: Reflect.get(meta, 'durationMs') as number,
      providerId: Reflect.get(meta, 'providerId') as string,
      model: Reflect.get(meta, 'model') as string,
      usage: {
        records: Reflect.get(usage, 'records') as number,
        promptTokens: Reflect.get(usage, 'promptTokens') as number,
        completionTokens: Reflect.get(usage, 'completionTokens') as number,
        reasoningTokens: Reflect.get(usage, 'reasoningTokens') as number,
        totalTokens: Reflect.get(usage, 'totalTokens') as number,
        cacheHitTokens: Reflect.get(usage, 'cacheHitTokens') as number,
        cacheMissTokens: Reflect.get(usage, 'cacheMissTokens') as number,
      },
      truncated: Reflect.get(meta, 'truncated') as boolean,
    },
  }
}

function normalizedFailure(error: unknown): SubagentRuntimeError {
  if (error instanceof SubagentRuntimeError) return error
  if (error && typeof error === 'object' && 'code' in error) {
    return new SubagentRuntimeError(
      String(error.code).slice(0, 128) || 'SUBAGENT_FAILED',
      error instanceof Error ? error.message : 'Subagent execution failed',
    )
  }
  return new SubagentRuntimeError(
    'SUBAGENT_FAILED',
    error instanceof Error ? error.message : 'Subagent execution failed',
  )
}

function redactText(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (current, secret) => current.split(secret).join('[redacted]'),
      value,
    )
}

function safeResultText(
  value: string,
  workspace: string,
  routes: FrozenSubagentRoutes,
): string {
  const withoutWorkspace = value.split(workspace).join('[workspace]')
  return redactText(withoutWorkspace, [
    routes.main.apiKey,
    routes.compression.apiKey,
    routes.main.snapshot.endpoint,
    routes.compression.snapshot.endpoint,
  ])
}

/** Owns the hidden Session, timeout, idempotency, and cleanup for one child. */
export class SubagentExecutionService implements PreparedSubagentExecutionPort {
  readonly #configStore: ConfigStore
  readonly #manager: SessionManager
  readonly #sessions: SessionService
  readonly #executionState: DurableExecutionStatePort
  readonly #state: SubagentStateService
  readonly #events: RuntimeEventSink
  readonly #onDiagnostic: DiagnosticSink
  readonly #active = new Map<string, ActiveExecution>()
  readonly #artifacts = new Map<AgentExecutionId, SubagentArtifacts>()
  readonly #starting = new Set<Promise<StartedExecution>>()
  readonly #startsByCall = new Map<string, StartingExecution>()
  readonly #cancelledBeforeLaunch = new Set<AgentExecutionId>()
  #disposing = false

  constructor(options: {
    configStore: ConfigStore
    manager: SessionManager
    sessions: SessionService
    executionState: DurableExecutionStatePort
    state: SubagentStateService
    events: RuntimeEventSink
    onDiagnostic?: DiagnosticSink
  }) {
    this.#configStore = options.configStore
    this.#manager = options.manager
    this.#sessions = options.sessions
    this.#executionState = options.executionState
    this.#state = options.state
    this.#events = options.events
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
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
    const artifacts = await this.#initializeArtifacts(
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
    await this.#initializeArtifacts(record, parent.sessionTemp)
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
    const promise = this.#execute({
      ...input,
      controller,
      timeoutReason,
    }).finally(() => {
      input.cancellationSignal?.removeEventListener('abort', cancel)
      this.#active.delete(input.record.id)
    })
    this.#active.set(input.record.id, {
      controller,
      promise,
      parentSessionId: input.record.parentSessionId,
    })
    return promise
  }

  async #execute(input: {
    spec: SubagentSpec
    parent: SubagentParentContext
    routes: ReturnType<SessionManager['frozenSubagentRoutes']>
    toolContext: FrozenSubagentToolContext
    record: SubagentExecutionRecord
    controller: AbortController
    timeoutReason: SubagentRuntimeError
    workerTimeoutMs: number
  }): Promise<SubagentRunResult> {
    const startedAt = performance.now()
    let childSessionId: SessionId | undefined
    let sessionCreated = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let usage: LlmUsageRecord[] = []
    try {
      const parentRecord = await this.#sessions.getRecord(
        input.parent.sessionId,
      )
      childSessionId = `subagent-session-${randomUUID()}` as SessionId
      if (input.controller.signal.aborted) {
        throw input.controller.signal.reason
      }
      timeout = setTimeout(
        () => input.controller.abort(input.timeoutReason),
        input.workerTimeoutMs,
      )
      const createdAt = new Date().toISOString()
      await this.#manager.createInternalSession({
        sessionId: childSessionId,
        workspace: input.parent.workspace,
        mode: input.toolContext.permissionMode,
        provider: input.routes.main.snapshot.providerId,
        modelSelection: {
          providerId: input.routes.main.snapshot.providerId,
          model: input.routes.main.snapshot.model,
          reasoning: input.routes.main.snapshot.reasoning,
        },
        providerSnapshot: input.routes.main.provider,
        allowedToolIds: input.toolContext.allowedToolIds,
        gitToolsEnabled: input.toolContext.gitToolsEnabled,
        execution: {
          executionId: input.record.id,
          parentSessionId: input.parent.sessionId,
          parentRunId: input.parent.runId,
          parentCallId: input.parent.callId,
          name: input.spec.name,
          createdAt: input.record.createdAt,
        },
      })
      sessionCreated = true
      const seed: SessionRecord = {
        schemaVersion: 1,
        id: childSessionId,
        projectId: parentRecord.projectId,
        title: `Subagent: ${input.spec.name}`.slice(0, 256),
        titleSource: 'user',
        lifecycle: 'active',
        permissionMode: input.toolContext.permissionMode,
        modelSelection: {
          providerId: input.routes.main.snapshot.providerId,
          model: input.routes.main.snapshot.model,
          reasoning: input.routes.main.snapshot.reasoning,
        },
        goal: null,
        plan: null,
        revision: 1,
        lastSeq: 0,
        createdAt,
        updatedAt: createdAt,
      }
      this.#executionState.registerInternalNew(seed, input.record.id, {
        executionId: input.record.id,
        parentSessionId: input.parent.sessionId,
        createdAt,
      })
      input.record.status = 'running'
      input.record.updatedAt = new Date().toISOString()
      await this.#state.updateExecution(input.record)
      this.#publishExecutionChanged(input.record, input.spec.name)
      this.#appendActivity(input.record, {
        ts: input.record.updatedAt,
        type: 'status',
        status: 'running',
      })

      const swarmAssignment = input.spec.sharedContext
        ? {
            context: {
              content: swarmSharedContextContent(input.spec.sharedContext),
              source: 'swarm:shared-context',
            },
            task: swarmTaskContent(input.spec.task),
          }
        : undefined
      const childRun = this.#manager.startInternalRun({
        sessionId: childSessionId,
        task: swarmAssignment?.task ?? input.spec.task,
        ...(swarmAssignment ? { context: swarmAssignment.context } : {}),
        clientRequestId: `subagent-${randomUUID()}`,
        routes: input.routes,
      })
      const interrupt = () =>
        this.#manager.interruptRun(childSessionId!, childRun.runId)
      if (input.controller.signal.aborted) interrupt()
      else
        input.controller.signal.addEventListener('abort', interrupt, {
          once: true,
        })
      let outcome
      try {
        outcome = await childRun.completion
      } finally {
        input.controller.signal.removeEventListener('abort', interrupt)
      }
      usage = outcome.usage
      await this.#manager.recordSubagentUsage({
        sessionId: input.parent.sessionId,
        runId: input.parent.runId,
        callId: input.parent.callId,
        usage,
      })
      if (input.controller.signal.aborted) throw input.controller.signal.reason
      if (outcome.status !== 'completed') {
        throw new SubagentRuntimeError(
          outcome.error?.code ?? 'SUBAGENT_RUN_FAILED',
          outcome.error?.message ?? `Subagent Run ended as ${outcome.status}`,
        )
      }
      if (!outcome.response) {
        throw new SubagentRuntimeError(
          'SUBAGENT_EMPTY_RESPONSE',
          'Subagent completed without a final assistant response',
        )
      }
      const response = safeResultText(
        outcome.response,
        input.parent.workspace,
        input.routes,
      )
      const result: SubagentRunResult = {
        results: { [input.spec.name]: response },
        meta: {
          durationMs: Math.round(performance.now() - startedAt),
          providerId: input.routes.main.snapshot.providerId,
          model: input.routes.main.snapshot.model,
          usage: summarizeSubagentUsage(usage),
          truncated: OUTPUT_FINISH_REASONS.has(
            outcome.finishReason?.toLowerCase() ?? '',
          ),
        },
      }
      const completedAt = new Date().toISOString()
      input.record.status = 'completed'
      input.record.usage = json(result.meta.usage)
      input.record.result = json(result)
      input.record.updatedAt = completedAt
      input.record.completedAt = completedAt
      await this.#writeResultArtifact(
        input.record,
        input.parent.sessionTemp,
        response,
      )
      this.#appendActivity(input.record, {
        ts: completedAt,
        type: 'result',
        status: 'completed',
        resultPath: this.#artifacts.get(input.record.id)?.resultPath,
        usage: result.meta.usage,
      })
      await this.#settleArtifactWrites(input.record.id)
      await this.#state.updateExecution(input.record)
      this.#publishExecutionChanged(input.record, input.spec.name)
      return result
    } catch (error) {
      const failure = input.controller.signal.aborted
        ? input.controller.signal.reason === input.timeoutReason
          ? input.timeoutReason
          : input.controller.signal.reason instanceof SubagentRuntimeError
            ? input.controller.signal.reason
            : new SubagentRuntimeError(
                'SUBAGENT_CANCELLED',
                'Subagent execution was cancelled with its parent Run',
              )
        : normalizedFailure(error)
      const safeFailure = new SubagentRuntimeError(
        failure.code,
        redactText(failure.message, [
          input.routes.main.apiKey,
          input.routes.compression.apiKey,
          input.routes.main.snapshot.endpoint,
          input.routes.compression.snapshot.endpoint,
          input.parent.workspace,
        ]),
      )
      const completedAt = new Date().toISOString()
      const cancelled = input.controller.signal.aborted
      input.record.status =
        input.controller.signal.reason === input.timeoutReason
          ? 'timed_out'
          : cancelled
            ? 'cancelled'
            : 'failed'
      input.record.usage = json(summarizeSubagentUsage(usage))
      input.record.error = {
        code: safeFailure.code.slice(0, 128) || 'SUBAGENT_FAILED',
        message: safeFailure.message.slice(0, MAX_ERROR_LENGTH),
      }
      input.record.updatedAt = completedAt
      input.record.completedAt = completedAt
      this.#appendActivity(input.record, {
        ts: completedAt,
        type: 'error',
        status: input.record.status,
        error: input.record.error,
      })
      await this.#settleArtifactWrites(input.record.id)
      await this.#state.updateExecution(input.record).then(
        () => this.#publishExecutionChanged(input.record, input.spec.name),
        (stateError) =>
          this.#onDiagnostic(
            'Failed to persist Subagent terminal status',
            stateError,
            { audience: 'internal' },
          ),
      )
      throw safeFailure
    } finally {
      if (timeout) clearTimeout(timeout)
      if (childSessionId && sessionCreated) {
        await this.#manager.closeSession(childSessionId).catch((error) =>
          this.#onDiagnostic(
            'Failed to close internal Subagent Session',
            error,
            {
              audience: 'internal',
            },
          ),
        )
        this.#executionState.forget(childSessionId, input.record.id)
      }
    }
  }

  #publishExecutionChanged(
    record: SubagentExecutionRecord,
    name: string,
  ): void {
    this.#events.publishAgentExecution({
      type: 'execution.changed',
      executionId: record.id,
      parentSessionId: record.parentSessionId,
      parentRunId: record.parentRunId,
      parentCallId: record.parentCallId,
      summary: projectAgentExecutionSummary(record, { name }),
    })
  }

  async #initializeArtifacts(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<SubagentArtifacts> {
    const existing = this.#artifacts.get(record.id)
    if (existing) return existing
    if (!sessionTemp) {
      const unavailable: SubagentArtifacts = {
        directory: '',
        activityPath: '',
        resultPath: '',
        available: false,
        captureError: 'Session temp is unavailable',
        tail: Promise.resolve(),
      }
      this.#artifacts.set(record.id, unavailable)
      return unavailable
    }
    const directory = path.join(sessionTemp.artifacts, 'subagents', record.id)
    const artifacts: SubagentArtifacts = {
      directory,
      activityPath: path.join(directory, 'activity.jsonl'),
      resultPath: path.join(directory, 'result.md'),
      sessionTemp,
      available: true,
      tail: Promise.resolve(),
    }
    this.#artifacts.set(record.id, artifacts)
    try {
      await writeSessionArtifactText(
        sessionTemp,
        ['subagents', record.id, 'activity.jsonl'],
        `${JSON.stringify({
          ts: new Date().toISOString(),
          type: 'status',
          status: record.status,
          executionId: record.id,
          name: record.name,
        })}\n`,
      )
    } catch (error) {
      artifacts.available = false
      artifacts.captureError =
        error instanceof Error ? error.message : String(error)
    }
    return artifacts
  }

  #appendActivity(record: SubagentExecutionRecord, value: unknown): void {
    const artifacts = this.#artifacts.get(record.id)
    if (!artifacts?.available) return
    artifacts.tail = artifacts.tail
      .then(async () => {
        await appendFile(artifacts.activityPath, `${JSON.stringify(value)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        if (
          artifacts.sessionTemp &&
          record.status !== 'queued' &&
          record.status !== 'preparing' &&
          record.status !== 'running'
        ) {
          await touchSessionTempPath(artifacts.sessionTemp)
        }
      })
      .catch((error: unknown) => {
        artifacts.available = false
        artifacts.captureError =
          error instanceof Error ? error.message : String(error)
      })
  }

  async #settleArtifactWrites(executionId: AgentExecutionId): Promise<void> {
    await this.#artifacts.get(executionId)?.tail
  }

  async #writeResultArtifact(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
    response: string,
  ): Promise<void> {
    const artifacts = this.#artifacts.get(record.id)
    if (!artifacts?.available || !sessionTemp) return
    await artifacts.tail
    try {
      await writeSessionArtifactText(
        sessionTemp,
        ['subagents', record.id, 'result.md'],
        response,
      )
    } catch (error) {
      artifacts.available = false
      artifacts.captureError =
        error instanceof Error ? error.message : String(error)
    }
  }

  #artifactHandle(
    record: SubagentExecutionRecord,
    artifacts: SubagentArtifacts,
  ): BackgroundTaskHandle {
    return {
      target: { type: 'subagent', id: record.id },
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
    const activeArtifacts = this.#artifacts.get(record.id)
    if (activeArtifacts) return this.#artifactHandle(record, activeArtifacts)
    if (!sessionTemp) {
      return {
        target: { type: 'subagent', id: record.id },
        status: record.status,
        artifactAvailable: false,
        captureError: 'Session temp is unavailable',
      }
    }
    const directory = path.join(sessionTemp.artifacts, 'subagents', record.id)
    try {
      await access(path.join(directory, 'activity.jsonl'))
      return {
        target: { type: 'subagent', id: record.id },
        status: record.status,
        artifactAvailable: true,
        artifactPath: directory,
      }
    } catch {
      return {
        target: { type: 'subagent', id: record.id },
        status: record.status,
        artifactAvailable: false,
      }
    }
  }

  /** Cancels one active or durably queued child without its original parent Run. */
  async cancel(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    const active = this.#active.get(executionId)
    if (active?.parentSessionId === parentSessionId) {
      active.controller.abort(
        new SubagentRuntimeError(
          'SUBAGENT_CANCELLED',
          `Subagent ${executionId} was cancelled`,
        ),
      )
      return true
    }
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
    this.#appendActivity(record, {
      ts: completedAt,
      type: 'error',
      status: record.status,
      error: record.error,
    })
    await this.#settleArtifactWrites(record.id)
    this.#publishExecutionChanged(record, record.name)
    return true
  }

  /** Returns current capture truth without treating artifact files as authority. */
  artifactStatus(
    executionId: AgentExecutionId,
  ): import('./contracts').BackgroundArtifactStatus | undefined {
    const artifacts = this.#artifacts.get(executionId)
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
  }
}
