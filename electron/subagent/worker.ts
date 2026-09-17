import { randomUUID } from 'node:crypto'
import type { RunId, SessionId } from '../../shared/ids'
import type { LlmUsageRecord } from '../../shared/usage'
import type { SessionManager } from '../session/session-manager'
import type { SubagentStateService } from '../application/subagent-state-service'
import type { DurableExecutionStatePort } from '../application/durable-execution-state-port'
import type { DiagnosticSink } from '../diagnostics'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { SessionTempPaths } from '../session-temp/service'
import type { RunPauseReason } from '../session/run-pause-control'
import type { SubagentArtifacts } from './execution-artifacts'
import { WorkerDeadline } from './worker-deadline'
import {
  swarmSharedContextContent,
  swarmTaskContent,
} from './assignment-prompt'
import {
  json,
  normalizedFailure,
  redactText,
  safeResultText,
} from './execution-validation'
import {
  SubagentRuntimeError,
  summarizeSubagentUsage,
  type SubagentSpec,
  type SubagentParentContext,
  type SubagentRunResult,
  type FrozenSubagentRoutes,
  type FrozenSubagentToolContext,
} from './contracts'

const MAX_ERROR_LENGTH = 65_536
const OUTPUT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'model_length',
])

export interface ActiveSubagentWorker {
  capacityLimit: number
  deadline?: WorkerDeadline
  runId?: RunId
  pauseReason?: RunPauseReason
  resumePromise?: Promise<boolean>
  controller: AbortController
  promise: Promise<SubagentRunResult>
  parentSessionId: SessionId
  record: SubagentExecutionRecord
  childSessionId?: SessionId
}

export interface SubagentWorkerInput {
  spec: SubagentSpec
  parent: SubagentParentContext
  routes: FrozenSubagentRoutes
  toolContext: FrozenSubagentToolContext
  record: SubagentExecutionRecord
  controller: AbortController
  workerTimeoutMs: number
  active: ActiveSubagentWorker
  parentMessage?: boolean
  onStarted?: () => void
  onPaused?: () => void
  onCarryover?: (
    messages: import('../session/session-types').RunInterjection[],
  ) => void
  manager: SessionManager
  executionState: DurableExecutionStatePort
  state: SubagentStateService
  onDiagnostic: DiagnosticSink
  publish: (record: SubagentExecutionRecord, name: string) => void
  appendActivity: (record: SubagentExecutionRecord, value: unknown) => void
  writeResult: (
    record: SubagentExecutionRecord,
    temp: SessionTempPaths | undefined,
    response: string,
  ) => Promise<void>
  artifacts: () => SubagentArtifacts | undefined
}

/** Executes and settles one worker while its service owns stable identity and control admission. */
export async function executeSubagentWorker(
  input: SubagentWorkerInput,
): Promise<SubagentRunResult> {
  const startedAt = performance.now()
  let childSessionId: SessionId | undefined
  let sessionCreated = false
  let deadline: WorkerDeadline | undefined
  let usage: LlmUsageRecord[] = []
  const stopTerminals = () => {
    if (!childSessionId) return
    try {
      input.manager.backgroundTerminalPool().closeSession(childSessionId, true)
    } catch (error) {
      input.onDiagnostic('Failed to request Subagent terminal cleanup', error, {
        audience: 'internal',
      })
    }
  }
  const closeInternalSession = async () => {
    if (!childSessionId || !sessionCreated) return
    await input.manager.closeSession(childSessionId)
    sessionCreated = false
    input.executionState.forget(childSessionId, input.record.id)
  }
  input.controller.signal.addEventListener('abort', stopTerminals)
  try {
    childSessionId = input.record.childSessionId
    if (!childSessionId)
      throw new Error('Worker has no persistent child Session')
    await input.state.capacity.acquire(
      input.parent.sessionId,
      input.record.id,
      input.parent.maxSubagents ?? 32,
      input.controller.signal,
    )
    const durable = await input.state.loadRuntimeState(childSessionId)
    const active = input.active
    if (active) active.childSessionId = childSessionId
    if (input.controller.signal.aborted) {
      throw input.controller.signal.reason
    }
    deadline = new WorkerDeadline(input.workerTimeoutMs, () => {
      const worker = input.active
      if (!worker || worker.controller.signal.aborted) return
      worker.pauseReason = 'timeout'
      if (worker.childSessionId && worker.runId)
        input.manager.pauseRun(worker.childSessionId, worker.runId, 'timeout')
      input.publish(input.record, input.spec.name)
    })
    if (active) active.deadline = deadline
    const createdAt = new Date().toISOString()
    await input.manager.createInternalSession({
      sessionId: childSessionId,
      restore: durable,
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
    input.executionState.registerInternalExisting(
      durable.record,
      input.record.id,
      {
        executionId: input.record.id,
        parentSessionId: input.parent.sessionId,
        createdAt,
      },
    )
    if (input.controller.signal.aborted) throw input.controller.signal.reason
    input.record.childRunId = `run-${randomUUID()}` as RunId
    input.record.status = 'running'
    input.record.updatedAt = new Date().toISOString()
    await input.state.updateExecution(input.record)
    input.publish(input.record, input.spec.name)
    input.appendActivity(input.record, {
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
    const childRun = input.manager.startInternalRun({
      sessionId: childSessionId,
      runId: input.record.childRunId,
      parentMessage: input.parentMessage,
      onInterjectionCarryover: input.onCarryover,
      task: swarmAssignment?.task ?? input.spec.task,
      ...(swarmAssignment ? { context: swarmAssignment.context } : {}),
      clientRequestId: `subagent-${randomUUID()}`,
      routes: input.routes,
      onStatusChange: (status) => {
        deadline?.phase(status)
        if (status === 'paused') {
          input.state.capacity.release(input.record.id)
          input.publish(input.record, input.spec.name)
          input.onPaused?.()
        }
      },
    })
    if (active) {
      active.runId = childRun.runId
      if (active.pauseReason)
        input.manager.pauseRun(
          childSessionId,
          childRun.runId,
          active.pauseReason,
        )
    }
    input.onStarted?.()
    const interrupt = () =>
      input.manager.interruptRun(childSessionId!, childRun.runId)
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
    await input.manager.recordSubagentUsage({
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
    input.record.usage = structuredClone(result.meta.usage)
    input.record.result = json(result)
    input.record.updatedAt = completedAt
    input.record.completedAt = completedAt
    await input.writeResult(input.record, input.parent.sessionTemp, response)
    input.appendActivity(input.record, {
      ts: completedAt,
      type: 'result',
      status: 'completed',
      resultPath: input.artifacts()?.resultPath,
      usage: result.meta.usage,
    })
    await input.artifacts()?.tail
    if (input.controller.signal.aborted) throw input.controller.signal.reason
    await closeInternalSession()
    if (input.controller.signal.aborted) throw input.controller.signal.reason
    await input.state.updateExecution(input.record)
    input.publish(input.record, input.spec.name)
    return result
  } catch (error) {
    if (input.controller.signal.aborted && childSessionId) {
      stopTerminals()
      await input.manager
        .backgroundTerminalPool()
        .waitForSessionExit(childSessionId)
    }
    await closeInternalSession().catch((cleanupError) =>
      input.onDiagnostic(
        'Failed to close internal Subagent Session',
        cleanupError,
        { audience: 'internal' },
      ),
    )
    const failure = input.controller.signal.aborted
      ? input.controller.signal.reason instanceof SubagentRuntimeError
        ? input.controller.signal.reason
        : new SubagentRuntimeError(
            'SUBAGENT_CANCELLED',
            'Subagent execution was cancelled',
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
    input.record.status = cancelled ? 'cancelled' : 'failed'
    input.record.usage = summarizeSubagentUsage(usage)
    input.record.error = {
      code: safeFailure.code.slice(0, 128) || 'SUBAGENT_FAILED',
      message: safeFailure.message.slice(0, MAX_ERROR_LENGTH),
    }
    input.record.updatedAt = completedAt
    input.record.completedAt = completedAt
    input.appendActivity(input.record, {
      ts: completedAt,
      type: 'error',
      status: input.record.status,
      error: input.record.error,
    })
    await input.artifacts()?.tail
    await input.state.updateExecution(input.record).then(
      () => input.publish(input.record, input.spec.name),
      (stateError) =>
        input.onDiagnostic(
          'Failed to persist Subagent terminal status',
          stateError,
          { audience: 'internal' },
        ),
    )
    throw safeFailure
  } finally {
    input.controller.signal.removeEventListener('abort', stopTerminals)
    deadline?.dispose()
    input.state.capacity.release(input.record.id)
    if (childSessionId && sessionCreated) {
      await input.manager.closeSession(childSessionId).catch((error) =>
        input.onDiagnostic('Failed to close internal Subagent Session', error, {
          audience: 'internal',
        }),
      )
      input.executionState.forget(childSessionId, input.record.id)
    }
  }
}
