import { createHash, randomUUID } from 'node:crypto'
import { accessPath as access } from '../common/filesystem'
import path from 'node:path'
import type { ModelCapabilityLevel } from '../../shared/config'
import type { AgentExecutionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import {
  MAX_SWARM_SHARED_CONTEXT_LENGTH,
  MAX_SWARM_TASK_LENGTH,
  MAX_SWARM_TASK_NAME_LENGTH,
  SwarmRunResultSchema,
  type SwarmAgentResult,
  type SwarmRunArgs,
  type SwarmRunResult,
  type SwarmTask,
} from '../../shared/swarm'
import type { ConfigStore } from '../config/store'
import {
  ModelPoolAllocationError,
  type ModelPoolAssignment,
} from '../model-pool/allocator'
import {
  freezeModelPoolPlan,
  type PreparedModelPoolAssignment,
} from '../model-pool/freezer'
import type { RuntimeEventSink } from '../runtime/runtime-events'
import type { SessionManager } from '../session/session-manager'
import type {
  PreparedSubagentExecutionPort,
  BackgroundTaskHandle,
  SubagentRunResult,
  SubagentSpec,
  SubagentUsageSummary,
} from '../subagent/contracts'
import { projectAgentExecutionSummary } from '../subagent/public-projection'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  SubagentCapacityError,
  type SubagentStateService,
} from '../application/subagent-state-service'
import { compileSchema } from '../schema-validator'
import {
  SwarmRuntimeError,
  type SwarmExecutionPort,
  type SwarmParentContext,
} from './contracts'
import {
  writeSessionArtifactJson,
  type SessionTempPaths,
} from '../session-temp/service'
import type { BackgroundAgentHandleRegistry } from '../background/agent-handle-registry'

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_SWARM_RESULT_BYTES = 2_000_000
const validateSwarmResult = compileSchema(SwarmRunResultSchema)

interface ExpandedChild {
  taskIndex: number
  agentIndex: number
  spec: SubagentSpec
}

interface PreparedChild extends ExpandedChild {
  assignment: PreparedModelPoolAssignment
  toolContext: ReturnType<SessionManager['frozenSubagentToolContext']>
  record: SubagentExecutionRecord
}

interface ActiveJob {
  promise: Promise<SwarmRunResult>
  controller: AbortController
  childIds: AgentExecutionId[]
}

interface SwarmArtifacts {
  path: string
  available: boolean
  captureError?: string
  manifestSeed?: {
    sharedContext: string
    tasks: SwarmRunArgs['tasks']
    children: Array<{
      executionId: AgentExecutionId
      taskIndex: number
      agentIndex: number
      assignment: ReturnType<typeof assignmentResult>
    }>
  }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function unicodeSlice(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join('')
}

function displayChildName(task: SwarmTask, agentIndex: number): string {
  if (task.agentCount === 1) return task.name
  const suffix = ` · ${agentIndex}/${task.agentCount}`
  return `${unicodeSlice(
    task.name,
    MAX_SWARM_TASK_NAME_LENGTH - [...suffix].length,
  )}${suffix}`
}

function displayRootName(
  goal: string | undefined,
  tasks: readonly SwarmTask[],
): string {
  const firstTask = tasks[0]?.name ?? 'Swarm'
  const label =
    goal?.trim() ||
    (tasks.length === 1 ? firstTask : `${firstTask} +${tasks.length - 1}`)
  return unicodeSlice(`Swarm · ${label}`, MAX_SWARM_TASK_NAME_LENGTH) || 'Swarm'
}

function normalizeArgs(args: SwarmRunArgs, maximum: number): SwarmRunArgs {
  const sharedContext = args.sharedContext.trim()
  if (
    [...sharedContext].length < 1 ||
    [...sharedContext].length > MAX_SWARM_SHARED_CONTEXT_LENGTH
  ) {
    throw new SwarmRuntimeError(
      'INVALID_SWARM_SHARED_CONTEXT',
      `Swarm shared context must contain 1-${MAX_SWARM_SHARED_CONTEXT_LENGTH} characters`,
    )
  }
  const names = new Set<string>()
  let total = 0
  const tasks = args.tasks.map((candidate) => {
    const name = candidate.name.trim().normalize('NFC')
    const task = candidate.task.trim()
    if (
      [...name].length < 1 ||
      [...name].length > MAX_SWARM_TASK_NAME_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(name) ||
      RESERVED_NAMES.has(name)
    ) {
      throw new SwarmRuntimeError(
        'INVALID_SWARM_TASK_NAME',
        `Swarm task names must be safe 1-${MAX_SWARM_TASK_NAME_LENGTH} character values`,
      )
    }
    if (names.has(name)) {
      throw new SwarmRuntimeError(
        'DUPLICATE_SWARM_TASK_NAME',
        `Duplicate Swarm task name: ${name}`,
      )
    }
    names.add(name)
    if ([...task].length < 1 || [...task].length > MAX_SWARM_TASK_LENGTH) {
      throw new SwarmRuntimeError(
        'INVALID_SWARM_TASK',
        `Swarm tasks must contain 1-${MAX_SWARM_TASK_LENGTH} characters`,
      )
    }
    total += candidate.agentCount
    return { ...candidate, name, task }
  })
  if (total < 1 || total > maximum) {
    throw new SwarmRuntimeError(
      'SWARM_AGENT_LIMIT_EXCEEDED',
      `A Swarm Job may create at most ${maximum} Agents`,
    )
  }
  return { sharedContext, tasks }
}

function expandTasks(
  sharedContext: string,
  tasks: readonly SwarmTask[],
): ExpandedChild[] {
  return tasks.flatMap((task, taskIndex) =>
    Array.from({ length: task.agentCount }, (_, index) => ({
      taskIndex,
      agentIndex: index + 1,
      spec: {
        name: displayChildName(task, index + 1),
        task: task.task,
        toolAccess: task.toolAccess,
        sharedContext,
      },
    })),
  )
}

function emptyUsage(): SubagentUsageSummary {
  return {
    records: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
}

function addUsage(
  target: SubagentUsageSummary,
  source: SubagentUsageSummary,
): void {
  for (const field of Object.keys(target) as Array<
    keyof SubagentUsageSummary
  >) {
    target[field] += source[field]
  }
}

function recordUsage(record: SubagentExecutionRecord): SubagentUsageSummary {
  const candidate = record.usage
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return emptyUsage()
  }
  const usage = emptyUsage()
  for (const field of Object.keys(usage) as Array<keyof SubagentUsageSummary>) {
    const value = candidate[field]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      return emptyUsage()
    }
    usage[field] = value
  }
  return usage
}

function resultStatus(
  record: SubagentExecutionRecord | undefined,
): SwarmAgentResult['status'] {
  if (record?.status === 'cancelled') return 'cancelled'
  if (record?.status === 'timed_out') return 'timed_out'
  return 'failed'
}

function assignmentResult(assignment: ModelPoolAssignment) {
  return {
    providerId: assignment.providerId,
    model: assignment.model,
    reasoning: assignment.reasoning,
    capability: assignment.capability,
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return new TextDecoder().decode(bytes.subarray(0, maximumBytes))
}

function boundResult(result: SwarmRunResult): SwarmRunResult {
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_SWARM_RESULT_BYTES
  ) {
    return result
  }
  const originals = result.results.map(
    (entry) => entry.response ?? entry.error?.message ?? '',
  )
  let lower = 0
  let upper = Math.max(
    0,
    ...originals.map((value) => Buffer.byteLength(value, 'utf8')),
  )
  const emptyText = structuredClone(result)
  for (const entry of emptyText.results) {
    if (entry.response !== undefined) entry.response = ''
    else if (entry.error) entry.error.message = ''
    entry.truncated = true
  }
  let bounded = emptyText
  while (lower <= upper) {
    const perResponse = Math.floor((lower + upper) / 2)
    const candidate = structuredClone(result)
    for (const [index, entry] of candidate.results.entries()) {
      const text = truncateUtf8(originals[index]!, perResponse)
      if (entry.response !== undefined) entry.response = text
      else if (entry.error) entry.error.message = text
      entry.truncated = entry.truncated || text !== originals[index]
    }
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
      MAX_SWARM_RESULT_BYTES
    ) {
      bounded = candidate
      lower = perResponse + 1
    } else {
      upper = perResponse - 1
    }
  }
  return bounded
}

function persistedResult(
  record: SubagentExecutionRecord,
): SwarmRunResult | undefined {
  if (!record.result || !validateSwarmResult(record.result)) return undefined
  return structuredClone(record.result) as SwarmRunResult
}

function normalizedError(error: unknown): SwarmRuntimeError {
  if (error instanceof SwarmRuntimeError) return error
  if (error instanceof ModelPoolAllocationError) {
    return new SwarmRuntimeError(
      'SWARM_MODEL_POOL_UNSATISFIED',
      `The model pool cannot satisfy ${error.capability} capability`,
    )
  }
  return new SwarmRuntimeError(
    error && typeof error === 'object' && 'code' in error
      ? String(error.code).slice(0, 128) || 'SWARM_FAILED'
      : 'SWARM_FAILED',
    error instanceof Error ? error.message : 'Swarm execution failed',
  )
}

/** Freezes model-pool assignments and owns durable Swarm Job convergence. */
export class SwarmCoordinator implements SwarmExecutionPort {
  readonly #configStore: ConfigStore
  readonly #manager: SessionManager
  readonly #state: SubagentStateService
  readonly #subagents: PreparedSubagentExecutionPort
  readonly #events: RuntimeEventSink
  readonly #handles: BackgroundAgentHandleRegistry
  readonly #active = new Map<AgentExecutionId, ActiveJob>()
  readonly #starting = new Set<Promise<void>>()
  readonly #artifacts = new Map<AgentExecutionId, SwarmArtifacts>()
  readonly #cancelled = new Set<AgentExecutionId>()
  #disposing = false

  constructor(options: {
    configStore: ConfigStore
    manager: SessionManager
    state: SubagentStateService
    subagents: PreparedSubagentExecutionPort
    events: RuntimeEventSink
    handles: BackgroundAgentHandleRegistry
  }) {
    this.#configStore = options.configStore
    this.#manager = options.manager
    this.#state = options.state
    this.#subagents = options.subagents
    this.#events = options.events
    this.#handles = options.handles
  }

  /** Starts one Swarm Job without serializing it against sibling Jobs. */
  run(args: SwarmRunArgs, parent: SwarmParentContext): Promise<SwarmRunResult> {
    return this.#beginRun(args, parent)
  }

  /** Starts a detached Swarm and resolves after durable reservation and manifest creation. */
  start(
    args: SwarmRunArgs,
    parent: SwarmParentContext,
  ): Promise<BackgroundTaskHandle> {
    return new Promise((resolve, reject) => {
      let handleReturned = false
      const execution = this.#beginRun(args, parent, (handle) => {
        handleReturned = true
        resolve(handle)
      })
      void execution.catch((error) => {
        if (!handleReturned) reject(error)
      })
    })
  }

  #beginRun(
    args: SwarmRunArgs,
    parent: SwarmParentContext,
    onStarted?: (handle: BackgroundTaskHandle) => void,
  ): Promise<SwarmRunResult> {
    let settlePreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      settlePreparation = resolve
    })
    const settle = () => {
      this.#starting.delete(preparation)
      settlePreparation()
    }
    this.#starting.add(preparation)
    const execution = this.#run(args, parent, (handle) => {
      onStarted?.(handle)
      settle()
    })
    void execution.then(settle, settle)
    return execution
  }

  async #run(
    candidate: SwarmRunArgs,
    parent: SwarmParentContext,
    onStarted?: (handle: BackgroundTaskHandle) => void,
  ): Promise<SwarmRunResult> {
    if (this.#disposing) {
      throw new SwarmRuntimeError(
        'SWARM_RUNTIME_DISPOSING',
        'Swarm runtime is shutting down',
      )
    }
    const context = this.#manager.frozenSwarmContext(
      parent.sessionId,
      parent.runId,
    )
    const maximum =
      parent.maxSubagents ??
      this.#configStore.getPublicConfig().subagents?.maxSubagents ??
      32
    const args = normalizeArgs(candidate, maximum)
    const argsHash = hash(args)
    const existing = await this.#state.getRootExecution({
      parentSessionId: parent.sessionId,
      parentRunId: parent.runId,
      parentCallId: parent.callId,
    })
    if (existing) {
      if (existing.kind !== 'swarm' || existing.specHash !== argsHash) {
        throw new SwarmRuntimeError(
          'SWARM_CALL_CONFLICT',
          'The parent Tool call was already used with different arguments',
        )
      }
      const handle = await this.#handleFor(existing, parent.sessionTemp)
      onStarted?.(handle)
      return this.#reuseExisting(existing, argsHash)
    }
    const expanded = expandTasks(args.sharedContext, args.tasks)
    const requirements = expanded.map(
      (child) =>
        args.tasks[child.taskIndex]!.requiredCapability as ModelCapabilityLevel,
    )
    let plan
    try {
      plan = await freezeModelPoolPlan(this.#configStore, requirements)
    } catch (error) {
      throw normalizedError(error)
    }
    if (parent.signal.aborted) throw parent.signal.reason

    const createdAt = new Date().toISOString()
    const rootId = `swarm-${randomUUID()}` as AgentExecutionId
    const root: SubagentExecutionRecord = {
      id: rootId,
      kind: 'swarm',
      name: displayRootName(context.goal, args.tasks),
      parentSessionId: parent.sessionId,
      parentRunId: parent.runId,
      parentCallId: parent.callId,
      specHash: argsHash,
      status: 'preparing',
      route: json({ schemaVersion: 1, modelPoolPlan: plan.safeSnapshot }),
      createdAt,
      updatedAt: createdAt,
    }
    const children: PreparedChild[] = expanded.map((child, childOrdinal) => {
      const assignment = plan.assignments[childOrdinal]!
      return {
        ...child,
        assignment,
        toolContext: this.#manager.frozenSubagentToolContext(
          parent.sessionId,
          parent.runId,
          child.spec.toolAccess,
        ),
        record: {
          id: `subagent-${randomUUID()}` as AgentExecutionId,
          kind: 'subagent',
          parentExecutionId: rootId,
          childOrdinal,
          name: child.spec.name,
          parentSessionId: parent.sessionId,
          parentRunId: parent.runId,
          parentCallId: parent.callId,
          specHash: hash(child.spec),
          status: 'queued',
          route: json({
            schemaVersion: 1,
            main: assignment.routes.main.snapshot,
            compression: assignment.routes.compression.snapshot,
          }),
          createdAt,
          updatedAt: createdAt,
        },
      }
    })
    let reserved
    try {
      reserved = await this.#state.createSwarmJob(
        root,
        children.map((child) => child.record),
        maximum,
      )
    } catch (error) {
      if (error instanceof SubagentCapacityError) {
        throw new SwarmRuntimeError(error.capacityCode, error.message)
      }
      throw new SwarmRuntimeError(
        'SWARM_START_FAILED',
        error instanceof Error
          ? error.message
          : 'Swarm durable reservation failed',
      )
    }
    if (!reserved.created) {
      if (reserved.root.specHash !== root.specHash) {
        throw new SwarmRuntimeError(
          'SWARM_CALL_CONFLICT',
          'The parent Tool call was already used with different arguments',
        )
      }
      const active = this.#active.get(reserved.root.id)
      const handle = await this.#handleFor(reserved.root, parent.sessionTemp)
      onStarted?.(handle)
      if (active) return active.promise
      if (
        reserved.root.status === 'completed' ||
        reserved.root.status === 'partial'
      ) {
        const result = persistedResult(reserved.root)
        if (result) return result
        throw new SwarmRuntimeError(
          'SWARM_RESULT_CORRUPT',
          'The persisted Swarm result is invalid',
        )
      }
      throw new SwarmRuntimeError(
        reserved.root.error?.code ?? 'SWARM_ALREADY_FINALIZED',
        reserved.root.error?.message ??
          `Swarm execution is ${reserved.root.status}`,
      )
    }
    const artifacts = await this.#initializeManifest(
      root,
      children,
      args,
      parent.sessionTemp,
    )
    await this.#publishRoot(root)
    for (const child of children) this.#publishChild(child.record)
    const controller = new AbortController()
    const promise = this.#executeJob(
      root,
      children,
      parent,
      controller.signal,
    ).finally(() => {
      this.#active.delete(root.id)
      this.#cancelled.delete(root.id)
    })
    this.#active.set(root.id, {
      promise,
      controller,
      childIds: children.map((child) => child.record.id),
    })
    onStarted?.(this.#artifactHandle(root, artifacts))
    return promise
  }

  #reuseExisting(
    record: SubagentExecutionRecord,
    expectedHash: string,
  ): Promise<SwarmRunResult> {
    if (record.kind !== 'swarm' || record.specHash !== expectedHash) {
      return Promise.reject(
        new SwarmRuntimeError(
          'SWARM_CALL_CONFLICT',
          'The parent Tool call was already used with different arguments',
        ),
      )
    }
    const active = this.#active.get(record.id)
    if (active) return active.promise
    if (record.status === 'completed' || record.status === 'partial') {
      const result = persistedResult(record)
      return result
        ? Promise.resolve(result)
        : Promise.reject(
            new SwarmRuntimeError(
              'SWARM_RESULT_CORRUPT',
              'The persisted Swarm result is invalid',
            ),
          )
    }
    return Promise.reject(
      new SwarmRuntimeError(
        record.error?.code ?? 'SWARM_ALREADY_FINALIZED',
        record.error?.message ?? `Swarm execution is ${record.status}`,
      ),
    )
  }

  async #executeJob(
    root: SubagentExecutionRecord,
    children: readonly PreparedChild[],
    parent: SwarmParentContext,
    cancellationSignal: AbortSignal,
  ): Promise<SwarmRunResult> {
    const startedAt = performance.now()
    root.status = 'running'
    root.updatedAt = new Date().toISOString()
    await this.#state.updateExecution(root)
    await this.#publishRoot(root)
    await this.#updateManifest(root, parent.sessionTemp)

    const results = await Promise.all(
      children.map(async (child): Promise<SwarmAgentResult> => {
        const childStartedAt = performance.now()
        let completed: SubagentRunResult | undefined
        let failure: unknown
        try {
          completed = await this.#subagents.runPrepared(child.spec, parent, {
            executionId: child.record.id,
            parentExecutionId: root.id,
            childOrdinal: child.record.childOrdinal!,
            routes: child.assignment.routes,
            toolContext: child.toolContext,
            cancellationSignal,
          })
        } catch (error) {
          failure = error
        }
        const durable = await this.#state.getExecution(
          parent.sessionId,
          child.record.id,
        )
        await this.#publishRoot(root)
        await this.#updateManifest(root, parent.sessionTemp)
        if (completed) {
          return {
            taskIndex: child.taskIndex,
            agentIndex: child.agentIndex,
            name: child.spec.name,
            status: 'completed',
            response: Object.values(completed.results)[0] ?? '',
            assignment: assignmentResult(child.assignment),
            durationMs: completed.meta.durationMs,
            usage: completed.meta.usage,
            truncated: completed.meta.truncated,
          }
        }
        const normalized = normalizedError(failure)
        return {
          taskIndex: child.taskIndex,
          agentIndex: child.agentIndex,
          name: child.spec.name,
          status: resultStatus(durable),
          error: {
            code: (durable?.error?.code ?? normalized.code).slice(0, 128),
            message: (durable?.error?.message ?? normalized.message).slice(
              0,
              65_536,
            ),
          },
          assignment: assignmentResult(child.assignment),
          durationMs: Math.max(0, performance.now() - childStartedAt),
          usage: durable ? recordUsage(durable) : emptyUsage(),
          truncated: false,
        }
      }),
    )

    const completedCount = results.filter(
      (result) => result.status === 'completed',
    ).length
    const usage = emptyUsage()
    for (const result of results) addUsage(usage, result.usage)
    const completedAt = new Date().toISOString()
    root.usage = json(usage)
    root.updatedAt = completedAt
    root.completedAt = completedAt

    if (this.#cancelled.has(root.id) || cancellationSignal.aborted) {
      root.status = 'cancelled'
      root.error = {
        code: 'SWARM_CANCELLED',
        message: 'Swarm execution was cancelled',
      }
      await this.#state.updateExecution(root)
      await this.#publishRoot(root)
      await this.#updateManifest(root, parent.sessionTemp)
      throw new SwarmRuntimeError(root.error.code, root.error.message)
    }

    if (completedCount === 0) {
      root.status = 'failed'
      root.error = {
        code: 'SWARM_ALL_AGENTS_FAILED',
        message: `All ${results.length} Swarm Agents failed: ${results
          .map(
            (result) => `${result.name}=${result.error?.code ?? result.status}`,
          )
          .join(', ')}`.slice(0, 65_536),
      }
      await this.#state.updateExecution(root)
      await this.#publishRoot(root)
      await this.#updateManifest(root, parent.sessionTemp)
      throw new SwarmRuntimeError(root.error.code, root.error.message)
    }

    const result = boundResult({
      results,
      meta: {
        status: completedCount === results.length ? 'completed' : 'partial',
        agentCount: results.length,
        completedCount,
        failedCount: results.length - completedCount,
        durationMs: Math.max(0, performance.now() - startedAt),
        usage,
      },
    })
    root.status = result.meta.status
    root.result = json(result)
    await this.#state.updateExecution(root)
    await this.#publishRoot(root)
    await this.#updateManifest(root, parent.sessionTemp)
    return result
  }

  async #initializeManifest(
    root: SubagentExecutionRecord,
    children: readonly PreparedChild[],
    args: SwarmRunArgs,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<SwarmArtifacts> {
    const existing = this.#artifacts.get(root.id)
    if (existing) return existing
    if (!sessionTemp) {
      const unavailable = {
        path: '',
        available: false,
        captureError: 'Session temp is unavailable',
      }
      this.#artifacts.set(root.id, unavailable)
      return unavailable
    }
    const manifestSeed: NonNullable<SwarmArtifacts['manifestSeed']> = {
      sharedContext: args.sharedContext,
      tasks: structuredClone(args.tasks),
      children: children.map((child) => ({
        executionId: child.record.id,
        taskIndex: child.taskIndex,
        agentIndex: child.agentIndex,
        assignment: assignmentResult(child.assignment),
      })),
    }
    const artifact: SwarmArtifacts = {
      path: path.join(
        sessionTemp.artifacts,
        'swarms',
        root.id,
        'manifest.json',
      ),
      available: true,
      manifestSeed,
    }
    this.#artifacts.set(root.id, artifact)
    try {
      await writeSessionArtifactJson(
        sessionTemp,
        ['swarms', root.id, 'manifest.json'],
        {
          schemaVersion: 2,
          kind: 'swarm',
          status: root.status,
          createdAt: root.createdAt,
          sharedContext: manifestSeed.sharedContext,
          tasks: manifestSeed.tasks,
          children: children.map((child) => ({
            childOrdinal: child.record.childOrdinal,
            taskIndex: child.taskIndex,
            agentIndex: child.agentIndex,
            name: child.record.name,
            status: child.record.status,
            artifactPath: path.join(
              sessionTemp.artifacts,
              'subagents',
              child.record.id,
            ),
            assignment: assignmentResult(child.assignment),
          })),
        },
      )
    } catch (error) {
      artifact.available = false
      artifact.captureError =
        error instanceof Error ? error.message : String(error)
    }
    return artifact
  }

  async #updateManifest(
    root: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<void> {
    const artifact = this.#artifacts.get(root.id)
    if (!artifact?.available || !sessionTemp) return
    try {
      const children = await this.#state.listChildren(
        root.parentSessionId,
        root.id,
      )
      const childSeeds = new Map(
        artifact.manifestSeed?.children.map((child) => [
          child.executionId,
          child,
        ]),
      )
      await writeSessionArtifactJson(
        sessionTemp,
        ['swarms', root.id, 'manifest.json'],
        {
          schemaVersion: 2,
          kind: 'swarm',
          status: root.status,
          createdAt: root.createdAt,
          updatedAt: root.updatedAt,
          completedAt: root.completedAt,
          counts: await this.#state.executionCounts(root.id),
          sharedContext: artifact.manifestSeed?.sharedContext,
          tasks: artifact.manifestSeed?.tasks,
          children: children.map((child) => ({
            childOrdinal: child.childOrdinal,
            taskIndex: childSeeds.get(child.id)?.taskIndex,
            agentIndex: childSeeds.get(child.id)?.agentIndex,
            name: child.name,
            status: child.status,
            artifactPath: path.join(
              sessionTemp.artifacts,
              'subagents',
              child.id,
            ),
            assignment: childSeeds.get(child.id)?.assignment,
            error: child.error,
          })),
        },
      )
    } catch (error) {
      artifact.available = false
      artifact.captureError =
        error instanceof Error ? error.message : String(error)
    }
  }

  #artifactHandle(
    record: SubagentExecutionRecord,
    artifact: SwarmArtifacts,
  ): BackgroundTaskHandle {
    return {
      target: this.#targetFor(record),
      status: record.status,
      artifactAvailable: artifact.available,
      ...(artifact.available ? { artifactPath: artifact.path } : {}),
      ...(artifact.captureError ? { captureError: artifact.captureError } : {}),
    }
  }

  async #handleFor(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<BackgroundTaskHandle> {
    const active = this.#artifacts.get(record.id)
    if (active) return this.#artifactHandle(record, active)
    if (!sessionTemp) {
      return {
        target: this.#targetFor(record),
        status: record.status,
        artifactAvailable: false,
      }
    }
    const manifestPath = path.join(
      sessionTemp.artifacts,
      'swarms',
      record.id,
      'manifest.json',
    )
    try {
      await access(manifestPath)
      return {
        target: this.#targetFor(record),
        status: record.status,
        artifactAvailable: true,
        artifactPath: manifestPath,
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
      type: 'swarm',
      id: this.#handles.expose({
        executionId: record.id,
        parentSessionId: record.parentSessionId,
        type: 'swarm',
      }),
    }
  }

  /** Cancels one owned Swarm root and cascades to every unfinished child. */
  async cancel(
    parentSessionId: import('../../shared/ids').SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    const record = await this.#state.getExecution(parentSessionId, executionId)
    if (!record || record.kind !== 'swarm') return false
    const active = this.#active.get(executionId)
    if (!active) return false
    this.#cancelled.add(executionId)
    active.controller.abort(
      new SwarmRuntimeError('SWARM_CANCELLED', 'Swarm was cancelled'),
    )
    for (const childId of active.childIds) {
      await this.#subagents.cancel?.(parentSessionId, childId)
    }
    return true
  }

  /** Returns current manifest capture truth without trusting mutable files. */
  artifactStatus(
    executionId: AgentExecutionId,
  ): import('../subagent/contracts').BackgroundArtifactStatus | undefined {
    const artifact = this.#artifacts.get(executionId)
    if (!artifact) return undefined
    return {
      artifactAvailable: artifact.available,
      ...(artifact.available ? { artifactPath: artifact.path } : {}),
      ...(artifact.captureError ? { captureError: artifact.captureError } : {}),
    }
  }

  async #publishRoot(record: SubagentExecutionRecord): Promise<void> {
    const counts = await this.#state.executionCounts(record.id)
    this.#events.publishAgentExecution({
      type: 'execution.changed',
      executionId: record.id,
      parentSessionId: record.parentSessionId,
      parentRunId: record.parentRunId,
      parentCallId: record.parentCallId,
      summary: projectAgentExecutionSummary(record, { agentCounts: counts }),
    })
  }

  #publishChild(record: SubagentExecutionRecord): void {
    this.#events.publishAgentExecution({
      type: 'execution.changed',
      executionId: record.id,
      parentSessionId: record.parentSessionId,
      parentRunId: record.parentRunId,
      parentCallId: record.parentCallId,
      summary: projectAgentExecutionSummary(record),
    })
  }

  /** Waits for active Jobs while Subagent disposal propagates their aborts. */
  async dispose(): Promise<void> {
    this.#disposing = true
    await Promise.allSettled([...this.#starting])
    for (const [executionId, active] of this.#active) {
      this.#cancelled.add(executionId)
      active.controller.abort(
        new SwarmRuntimeError(
          'SWARM_RUNTIME_DISPOSING',
          'Swarm runtime is shutting down',
        ),
      )
    }
    await Promise.allSettled(
      [...this.#active.values()].map((active) => active.promise),
    )
  }
}
