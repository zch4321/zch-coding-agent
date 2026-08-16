import { createHash, randomUUID } from 'node:crypto'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import type { SessionManager } from '../session/session-manager'
import type { SessionService } from '../application/session-service'
import type { SubagentStateService } from '../application/subagent-state-service'
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
  summarizeSubagentUsage,
  type FrozenSubagentRoutes,
  type PreparedSubagentExecution,
  type PreparedSubagentExecutionPort,
  type SubagentParentContext,
  type SubagentRunResult,
  type SubagentSpec,
} from './contracts'

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
  return { name, task, ...(sharedContext ? { sharedContext } : {}) }
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
    this.#publishExecutionChanged(record, spec.name)

    return this.#launch({
      spec,
      parent,
      routes,
      record,
      workerTimeoutMs: config.subagents.workerTimeoutMs,
      queued: false,
    })
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
    this.#manager.frozenSubagentRoutes(parent.sessionId, parent.runId)
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
    return this.#launch({
      spec,
      parent,
      routes: prepared.routes,
      record,
      workerTimeoutMs: config.subagents.workerTimeoutMs,
      queued: true,
    })
  }

  #launch(input: {
    spec: SubagentSpec
    parent: SubagentParentContext
    routes: FrozenSubagentRoutes
    record: SubagentExecutionRecord
    workerTimeoutMs: number
    queued: boolean
  }): Promise<SubagentRunResult> {
    const controller = new AbortController()
    const timeoutReason = new SubagentRuntimeError(
      'SUBAGENT_TIMEOUT',
      'Subagent worker exceeded its configured timeout',
    )
    const relayParentAbort = () => controller.abort(input.parent.signal.reason)
    if (input.parent.signal.aborted) relayParentAbort()
    else
      input.parent.signal.addEventListener('abort', relayParentAbort, {
        once: true,
      })
    const promise = this.#execute({
      ...input,
      controller,
      timeoutReason,
    }).finally(() => {
      input.parent.signal.removeEventListener('abort', relayParentAbort)
      this.#active.delete(input.record.id)
    })
    this.#active.set(input.record.id, { controller, promise })
    return promise
  }

  async #execute(input: {
    spec: SubagentSpec
    parent: SubagentParentContext
    routes: ReturnType<SessionManager['frozenSubagentRoutes']>
    record: SubagentExecutionRecord
    controller: AbortController
    timeoutReason: SubagentRuntimeError
    workerTimeoutMs: number
    queued: boolean
  }): Promise<SubagentRunResult> {
    const startedAt = performance.now()
    let childSessionId: SessionId | undefined
    let sessionCreated = false
    let reservation:
      | Awaited<ReturnType<SessionManager['reserveQueuedInternalRun']>>
      | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let usage: LlmUsageRecord[] = []
    try {
      const parentRecord = await this.#sessions.getRecord(
        input.parent.sessionId,
      )
      childSessionId = `subagent-session-${randomUUID()}` as SessionId
      if (input.queued) {
        reservation = await this.#manager.reserveQueuedInternalRun({
          sessionId: childSessionId,
          workspace: input.parent.workspace,
          signal: input.controller.signal,
        })
      }
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
        provider: input.routes.main.snapshot.providerId,
        modelSelection: {
          providerId: input.routes.main.snapshot.providerId,
          model: input.routes.main.snapshot.model,
          reasoning: input.routes.main.snapshot.reasoning,
        },
        providerSnapshot: input.routes.main.provider,
        allowedToolIds: new Set([...CHILD_TOOL_IDS, ...CHILD_GIT_TOOL_IDS]),
        gitToolsEnabled: true,
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
      this.#publishExecutionChanged(input.record, input.spec.name)

      let childRun
      try {
        const swarmAssignment = input.spec.sharedContext
          ? {
              context: {
                content: swarmSharedContextContent(input.spec.sharedContext),
                source: 'swarm:shared-context',
              },
              task: swarmTaskContent(input.spec.task),
            }
          : undefined
        childRun = this.#manager.startInternalRun({
          sessionId: childSessionId,
          task: swarmAssignment?.task ?? input.spec.task,
          ...(swarmAssignment ? { context: swarmAssignment.context } : {}),
          clientRequestId: `subagent-${randomUUID()}`,
          routes: input.routes,
          ...(reservation ? { reservation } : {}),
        })
        reservation = undefined
      } catch (error) {
        reservation?.lease.release()
        reservation = undefined
        throw error
      }
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
      reservation?.lease.release()
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

  /** Cancels all queued/preparing/running children and waits for their cleanup. */
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
