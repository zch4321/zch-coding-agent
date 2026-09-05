import { randomUUID } from 'node:crypto'
import {
  json,
  hash,
  displayRootName,
  normalizeArgs,
  expandTasks,
  emptyUsage,
  addUsage,
  recordUsage,
  resultStatus,
  assignmentResult,
  boundResult,
  persistedResult,
  normalizedError,
  type ExpandedChild,
} from './execution-values'
import { accessPath as access } from '../common/filesystem'
import path from 'node:path'
import type { ModelCapabilityLevel } from '../../shared/config'
import type { AgentExecutionId } from '../../shared/ids'
import {
  type SwarmAgentResult,
  type SwarmRunArgs,
  type SwarmRunResult,
} from '../../shared/swarm'
import type { ConfigStore } from '../config/store'
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
} from '../subagent/contracts'
import { projectAgentExecutionSummary } from '../subagent/public-projection'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  SubagentCapacityError,
  type SubagentStateService,
} from '../application/subagent-state-service'
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
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  #disposing = false

  constructor(options: {
    onDiagnostic?: (message: string, error?: unknown) => void
    configStore: ConfigStore
    manager: SessionManager
    state: SubagentStateService
    subagents: PreparedSubagentExecutionPort
    events: RuntimeEventSink
    handles: BackgroundAgentHandleRegistry
  }) {
    this.#configStore = options.configStore
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
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
    const controller = new AbortController()
    if (this.#cancelled.has(root.id))
      controller.abort(
        new SwarmRuntimeError(
          'SWARM_CANCELLED',
          'Swarm was cancelled during preparation',
        ),
      )
    const promise = Promise.resolve()
      .then(async () => {
        const artifacts = await this.#initializeManifest(
          root,
          children,
          args,
          parent.sessionTemp,
        )
        await this.#publishRoot(root)
        for (const child of children) this.#publishChild(child.record)
        onStarted?.(this.#artifactHandle(root, artifacts))
        return this.#executeJob(root, children, parent, controller.signal)
      })
      .catch(async (error: unknown) => {
        const durable = await this.#state.getExecution(
          parent.sessionId,
          root.id,
        )
        if (
          durable &&
          ['queued', 'preparing', 'running'].includes(durable.status)
        ) {
          controller.abort(error)
          await Promise.allSettled(
            children.map((child) =>
              this.#subagents.cancel?.(parent.sessionId, child.record.id),
            ),
          )
          await Promise.all(
            children.map((child) =>
              this.#subagents.waitForSettlement?.(
                parent.sessionId,
                child.record.id,
              ),
            ),
          )
          for (const child of children) {
            const record = await this.#state.getExecution(
              parent.sessionId,
              child.record.id,
            )
            if (
              record &&
              ['queued', 'preparing', 'running'].includes(record.status)
            ) {
              record.status = this.#cancelled.has(root.id)
                ? 'cancelled'
                : 'failed'
              record.updatedAt = record.completedAt = new Date().toISOString()
              record.error = {
                code: 'SWARM_START_FAILED',
                message: 'Swarm preparation or execution failed',
              }
              await this.#state.updateExecution(record)
              this.#publishChild(record)
            }
          }
          root.status = this.#cancelled.has(root.id) ? 'cancelled' : 'failed'
          root.updatedAt = root.completedAt = new Date().toISOString()
          root.error = {
            code: this.#cancelled.has(root.id)
              ? 'SWARM_CANCELLED'
              : 'SWARM_START_FAILED',
            message: 'Swarm execution did not finish',
          }
          await this.#state.updateExecution(root)
          await this.#publishRoot(root)
          await this.#updateManifest(root, parent.sessionTemp)
        }
        throw error
      })
      .finally(() => {
        this.#active.delete(root.id)
        this.#cancelled.delete(root.id)
      })
    this.#active.set(root.id, {
      promise,
      controller,
      childIds: children.map((child) => child.record.id),
    })
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
      await Promise.all(
        children.map((child) =>
          this.#subagents.waitForSettlement?.(
            parent.sessionId,
            child.record.id,
          ),
        ),
      )
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

  /** Reports root cancellation intent, including the pre-activation window. */
  isStopRequested(executionId: AgentExecutionId): boolean {
    return this.#cancelled.has(executionId)
  }

  /** Cancels an owned root, retaining intent across durable reservation and activation. */
  async cancel(
    parentSessionId: import('../../shared/ids').SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    const record = await this.#state.getExecution(parentSessionId, executionId)
    if (!record || record.kind !== 'swarm') return false
    const active = this.#active.get(executionId)
    if (!active && !['queued', 'preparing', 'running'].includes(record.status))
      return false
    this.#cancelled.add(executionId)
    active?.controller.abort(
      new SwarmRuntimeError('SWARM_CANCELLED', 'Swarm was cancelled'),
    )
    const childIds =
      active?.childIds ??
      (await this.#state.listChildren(parentSessionId, executionId)).map(
        (child) => child.id,
      )
    const requests = await Promise.allSettled(
      childIds.map((childId) =>
        this.#subagents.cancel?.(parentSessionId, childId),
      ),
    )
    await this.#publishRoot(record)
    const failed = requests.find((request) => request.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
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
    try {
      const counts = await this.#state.executionCounts(record.id)
      this.#events.publishAgentExecution({
        type: 'execution.changed',
        executionId: record.id,
        parentSessionId: record.parentSessionId,
        parentRunId: record.parentRunId,
        parentCallId: record.parentCallId,
        summary: {
          ...projectAgentExecutionSummary(record, { agentCounts: counts }),
          stopRequested: this.isStopRequested(record.id),
        },
      })
    } catch (error) {
      this.#onDiagnostic('Failed to publish Swarm status', error)
    }
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
