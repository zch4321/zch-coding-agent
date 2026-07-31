import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import type { SessionManager } from '../session/session-manager'
import type { SessionService } from '../application/session-service'
import type { SubagentStateService } from '../application/subagent-state-service'
import type { DurableExecutionStatePort } from '../application/durable-execution-state-port'
import type { SessionRecord } from '../../shared/session'
import type { SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { LlmUsageRecord } from '../../shared/usage'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  SubagentRuntimeError,
  summarizeSubagentUsage,
  type SubagentExecutionPort,
  type FrozenSubagentRoutes,
  type SubagentParentContext,
  type SubagentRunResult,
  type SubagentSpec,
} from './contracts'
import {
  WorkspaceSnapshotError,
  WorkspaceSnapshotService,
} from './workspace-snapshot'

const CHILD_TOOL_IDS = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'read_skill',
  'delay',
])
const CHILD_GIT_TOOL_IDS = ['git_status', 'git_diff', 'git_log', 'git_show']
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
  return { name, task }
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
  if (error instanceof WorkspaceSnapshotError) {
    return new SubagentRuntimeError(error.code, error.message)
  }
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
  snapshotWorkspace: string,
  routes: FrozenSubagentRoutes,
): string {
  const withoutTemporaryWorkspace = value
    .split(snapshotWorkspace)
    .join('[workspace]')
    .split(path.dirname(snapshotWorkspace))
    .join('[snapshot]')
  return redactText(withoutTemporaryWorkspace, [
    routes.main.apiKey,
    routes.compression.apiKey,
    routes.main.snapshot.endpoint,
    routes.compression.snapshot.endpoint,
  ])
}

/** Owns snapshot, hidden Session, timeout, idempotency, and cleanup for one-child executions. */
export class SubagentExecutionService implements SubagentExecutionPort {
  readonly #configStore: ConfigStore
  readonly #manager: SessionManager
  readonly #sessions: SessionService
  readonly #executionState: DurableExecutionStatePort
  readonly #state: SubagentStateService
  readonly #snapshots: WorkspaceSnapshotService
  readonly #onDiagnostic: DiagnosticSink
  readonly #active = new Map<string, ActiveExecution>()
  #disposing = false

  constructor(options: {
    configStore: ConfigStore
    manager: SessionManager
    sessions: SessionService
    executionState: DurableExecutionStatePort
    state: SubagentStateService
    snapshots: WorkspaceSnapshotService
    onDiagnostic?: DiagnosticSink
  }) {
    this.#configStore = options.configStore
    this.#manager = options.manager
    this.#sessions = options.sessions
    this.#executionState = options.executionState
    this.#state = options.state
    this.#snapshots = options.snapshots
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Creates or idempotently reuses one execution for the parent Tool call. */
  async runOne(
    candidate: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<SubagentRunResult> {
    if (this.#disposing) {
      throw new SubagentRuntimeError(
        'SUBAGENT_RUNTIME_DISPOSING',
        'Subagent runtime is shutting down',
      )
    }
    const spec = normalizeSpec(candidate)
    const config = this.#configStore.getPublicConfig()
    if (config.limits.maxConcurrentRuns === 1) {
      throw new SubagentRuntimeError(
        'SUBAGENT_CONCURRENCY_DISABLED',
        'Subagent execution requires maxConcurrentRuns to be at least 2',
      )
    }
    const routes = this.#manager.frozenSubagentRoutes(
      parent.sessionId,
      parent.runId,
    )
    const timestamp = new Date().toISOString()
    const executionId = `subagent-${randomUUID()}`
    const record: SubagentExecutionRecord = {
      id: executionId,
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
    const reserved = await this.#state.createExecution(record)
    if (!reserved.created) {
      if (reserved.record.specHash !== record.specHash) {
        throw new SubagentRuntimeError(
          'SUBAGENT_CALL_CONFLICT',
          'The parent Tool call was already used with different arguments',
        )
      }
      const active = this.#active.get(reserved.record.id)
      if (active) return active.promise
      if (reserved.record.status === 'completed') {
        const result = completedResult(reserved.record, spec.name)
        if (result) return result
        throw new SubagentRuntimeError(
          'SUBAGENT_RESULT_CORRUPT',
          'The persisted Subagent result is invalid',
        )
      }
      throw new SubagentRuntimeError(
        reserved.record.error?.code ?? 'SUBAGENT_ALREADY_FINALIZED',
        reserved.record.error?.message ??
          `Subagent execution is ${reserved.record.status}`,
      )
    }

    const controller = new AbortController()
    const timeoutReason = new SubagentRuntimeError(
      'SUBAGENT_TIMEOUT',
      'Subagent worker exceeded its configured timeout',
    )
    const relayParentAbort = () => controller.abort(parent.signal.reason)
    if (parent.signal.aborted) relayParentAbort()
    else
      parent.signal.addEventListener('abort', relayParentAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(timeoutReason),
      config.subagents.workerTimeoutMs,
    )
    const promise = this.#execute({
      spec,
      parent,
      routes,
      record,
      controller,
      timeoutReason,
    }).finally(() => {
      clearTimeout(timeout)
      parent.signal.removeEventListener('abort', relayParentAbort)
      this.#active.delete(executionId)
    })
    this.#active.set(executionId, { controller, promise })
    return promise
  }

  async #execute(input: {
    spec: SubagentSpec
    parent: SubagentParentContext
    routes: ReturnType<SessionManager['frozenSubagentRoutes']>
    record: SubagentExecutionRecord
    controller: AbortController
    timeoutReason: SubagentRuntimeError
  }): Promise<SubagentRunResult> {
    const startedAt = performance.now()
    let childSessionId: SessionId | undefined
    let snapshot:
      | Awaited<ReturnType<WorkspaceSnapshotService['create']>>
      | undefined
    let usage: LlmUsageRecord[] = []
    try {
      snapshot = await this.#snapshots.create(
        input.parent.workspace,
        input.controller.signal,
      )
      input.record.sourceIdentity = WorkspaceSnapshotService.identityJson(
        snapshot.identity,
      )
      input.record.updatedAt = new Date().toISOString()
      await this.#state.updateExecution(input.record)

      const parentRecord = await this.#sessions.getRecord(
        input.parent.sessionId,
      )
      childSessionId = `subagent-session-${randomUUID()}` as SessionId
      const createdAt = new Date().toISOString()
      await this.#manager.createInternalSession({
        sessionId: childSessionId,
        workspace: snapshot.workspace,
        provider: input.routes.main.snapshot.providerId,
        modelSelection: {
          providerId: input.routes.main.snapshot.providerId,
          model: input.routes.main.snapshot.model,
          reasoning: input.routes.main.snapshot.reasoning,
        },
        providerSnapshot: input.routes.main.provider,
        allowedToolIds: new Set([
          ...CHILD_TOOL_IDS,
          ...(snapshot.gitAvailable ? CHILD_GIT_TOOL_IDS : []),
        ]),
        gitToolsEnabled: snapshot.gitAvailable,
      })
      const seed: SessionRecord = {
        schemaVersion: 1,
        id: childSessionId,
        projectId: parentRecord.projectId,
        title: `Subagent: ${input.spec.name}`.slice(0, 256),
        lifecycle: 'active',
        permissionMode: 'readonly',
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

      const childRun = this.#manager.startInternalRun({
        sessionId: childSessionId,
        task: input.spec.task,
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
        snapshot.workspace,
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
      await this.#state.updateExecution(input.record)
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
          ...(snapshot
            ? [snapshot.workspace, path.dirname(snapshot.workspace)]
            : []),
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
      await this.#state
        .updateExecution(input.record)
        .catch((stateError) =>
          this.#onDiagnostic(
            'Failed to persist Subagent terminal status',
            stateError,
            { audience: 'internal' },
          ),
        )
      throw safeFailure
    } finally {
      if (childSessionId) {
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
      await snapshot?.dispose().catch((error) =>
        this.#onDiagnostic('Failed to clean Subagent snapshot', error, {
          audience: 'internal',
        }),
      )
    }
  }

  /** Cancels all preparing/running children and waits for their cleanup. */
  async dispose(): Promise<void> {
    this.#disposing = true
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
