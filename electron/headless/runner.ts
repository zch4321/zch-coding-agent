import {
  accessPath as access,
  canonicalPath as realpath,
  makeDirectory as mkdir,
  makeTemporaryDirectory as mkdtemp,
  removePath as rm,
} from '../common/filesystem'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { AutoApprover } from '../permission/auto-approver'
import { RuntimeIdentitySchema } from '../../shared/runtime-identity'
import type { RuntimeIdentity } from '../../shared/runtime-identity'
import type { ModelProvider } from '../providers/provider'
import { createBackendRuntime } from '../application/create-backend-runtime'
import { createRuntimeIdentity, sha256Json } from '../runtime/runtime-identity'
import type { RunCompletion } from '../runtime/runtime-events'
import type { RuntimeEventListener } from '../runtime/runtime-events'
import type { ProjectId, SessionId } from '../../shared/ids'
import { getProviderConfig } from '../../shared/config'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { writeJsonAtomic } from '../config/atomic-file'
import { prepareHeadlessConfig } from './config'
import {
  HeadlessResultSchema,
  type HeadlessConfig,
  type HeadlessResult,
  type HeadlessRunStatus,
} from './contracts'
import { HeadlessEventWriter, HeadlessRunMetrics } from './event-stream'
import { headlessDatabasePath } from '../persistence/database-service'
import { OperationalLogService } from '../operational-logging/service'
import { nodeOperationalLoggerFactory } from '../operational-logging/node-logger'
import { diagnosticIdForError } from '../operational-logging/diagnostic-id'

const validateResult = compileSchema(HeadlessResultSchema)
const validateRuntimeIdentity = compileSchema(RuntimeIdentitySchema)

/** Reports invalid task, configuration, or workspace input for a headless run. */
export class HeadlessRunInputError extends Error {
  readonly code = 'HEADLESS_RUN_INPUT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'HeadlessRunInputError'
  }
}

export interface RunHeadlessAgentOptions {
  config: HeadlessConfig
  workspace: string
  task: string
  artifactsDirectory: string
  timeoutMs: number
  output: Writable
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  promptDirectory?: string
  fetchImpl?: typeof fetch
  providerFactory?: (options: {
    config: ReturnType<import('../config/store').ConfigStore['getPublicConfig']>
    apiKey: string
  }) => ModelProvider
  autoApproverFactory?: (options: {
    config: ReturnType<import('../config/store').ConfigStore['getPublicConfig']>
    apiKey: string
  }) => AutoApprover
  onDiagnostic?: (message: string, error?: unknown) => void
  sourceCommit?: string
  sourceTree?: RuntimeIdentity['sourceTree']
  runtimeImageDigest?: string
  eventListeners?: RuntimeEventListener[]
}

/** Runs the headless agent, captures events and patch artifacts, and returns its result. */
export async function runHeadlessAgent(
  options: RunHeadlessAgentOptions,
): Promise<HeadlessResult> {
  if (!options.task.trim() || Buffer.byteLength(options.task) > 1_048_576) {
    throw new HeadlessRunInputError(
      'Task must be non-empty and no larger than 1 MiB',
    )
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 86_400_000
  ) {
    throw new HeadlessRunInputError(
      'Timeout must be between 1 and 86400000 milliseconds',
    )
  }
  const startedAtDate = new Date()
  const startedAtMs = performance.now()
  let workspace: string
  try {
    workspace = await realpath(options.workspace)
  } catch {
    throw new HeadlessRunInputError('Workspace does not exist')
  }
  await mkdir(options.artifactsDirectory, { recursive: true })
  const artifactsDirectory = await realpath(options.artifactsDirectory)
  assertArtifactsOutsideWorkspace(workspace, artifactsDirectory)
  const prepared = await prepareHeadlessConfig({
    config: options.config,
    artifactsDirectory,
    environment: options.environment,
  })
  const provider = options.config.provider
  const resolvedProvider = getProviderConfig(
    prepared.configStore.getPublicConfig(),
    provider.id,
  )
  if (!resolvedProvider) {
    throw new HeadlessRunInputError(
      `Prepared provider is not available: ${provider.id}`,
    )
  }
  const writer = new HeadlessEventWriter(options.output)
  const metrics = new HeadlessRunMetrics(writer)
  let forwardRuntimeEvents = true
  const metricsListener: RuntimeEventListener = {
    onAgentEvent: (event) => {
      if (forwardRuntimeEvents) metrics.onAgentEvent(event)
    },
    onTerminalEvent: (event) => {
      if (forwardRuntimeEvents) metrics.onTerminalEvent(event)
    },
  }
  const databaseDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'zch-headless-db-'),
  )
  const operationalLogDirectory = path.join(
    prepared.userDataDirectory,
    'logs',
    'runtime',
  )
  const operationalLog = new OperationalLogService({
    directory: operationalLogDirectory,
    config: prepared.configStore.getPublicConfig().logging.operational,
    loggerFactory: nodeOperationalLoggerFactory,
    sanitizer: {
      workspace,
      userData: prepared.userDataDirectory,
    },
  })
  const stopProcessErrorCapture = operationalLog.startProcessErrorCapture()
  const headlessDiagnostic = (message: string, error?: unknown): void => {
    operationalLog.log({
      level: 'warn',
      event: 'backend.diagnostic',
      message,
      error,
      diagnosticId: diagnosticIdForError(error),
    })
    options.onDiagnostic?.(message, error)
  }
  const backend = await createBackendRuntime({
    configStore: prepared.configStore,
    databasePath: headlessDatabasePath(databaseDirectory),
    runtimeDataDirectory: prepared.userDataDirectory,
    swarmHostEnabled: false,
    conversationTitlingDisabled: true,
    promptDirectory: await resolvePromptDirectory(options.promptDirectory),
    fetchImpl: options.fetchImpl,
    providerFactory: options.providerFactory,
    autoApproverFactory: options.autoApproverFactory,
    eventListeners: [metricsListener, ...(options.eventListeners ?? [])],
    onDiagnostic: headlessDiagnostic,
    operationalLog,
    sessionTempRootDirectory: path.join(artifactsDirectory, 'sessions'),
  }).catch(async (error: unknown) => {
    operationalLog.log({
      level: 'error',
      event: 'backend.failed',
      code: 'BACKEND_STARTUP_FAILED',
      error,
    })
    stopProcessErrorCapture()
    await rm(databaseDirectory, { recursive: true, force: true })
    throw error
  })
  operationalLog.log({ level: 'info', event: 'backend.started' })
  const runtime = backend.runtime
  const controller = new AbortController()
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const relayAbort = () =>
    controller.abort(
      options.signal?.reason ?? new Error('Headless run cancelled'),
    )

  writer.write({
    type: 'runtime.started',
    workspace,
    providerId: provider.id,
    model: provider.model,
    permissionMode: 'yolo',
    configHash: prepared.configHash,
  })

  let sessionId: SessionId | undefined
  const runIds: HeadlessResult['runIds'] = []
  let completion: RunCompletion | undefined
  let autoPlanApprovals = 0
  let incompleteReason: HeadlessResult['incompleteReason']
  const armTimeout = (): void => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(
      () => {
        timedOut = true
        controller.abort(new Error('Headless run timed out'))
      },
      Math.max(1, options.timeoutMs),
    )
    timeout.unref()
  }

  try {
    try {
      const projectResult = await backend.projects.add({ path: workspace })
      const project = projectResult.commit.change.projects.find(
        (candidate) => candidate.path === workspace,
      )
      if (!project) {
        throw new Error('Headless durable Project was not created')
      }
      sessionId = `session:${randomUUID()}` as SessionId
      const firstRun = await backend.runs.start({
        version: 1,
        kind: 'new_session',
        sessionId,
        projectId: project.id as ProjectId,
        modelSelection: {
          providerId: provider.id,
          model: provider.model,
          reasoning: provider.reasoning ?? 'high',
        },
        permissionMode: 'yolo',
        message: options.task,
        clientRequestId: 'headless-task-1',
      })
      if (firstRun.outcome !== 'started') {
        throw new Error('Headless first run was unexpectedly deduplicated')
      }
      const firstRunId = firstRun.runId
      const interruptFirstRun = () => runtime.interrupt(sessionId!, firstRunId)
      options.signal?.addEventListener('abort', relayAbort, { once: true })
      controller.signal.addEventListener('abort', interruptFirstRun, {
        once: true,
      })
      if (options.signal?.aborted) relayAbort()
      armTimeout()
      runIds.push(firstRunId)
      try {
        completion = await runtime.events.waitForRun(sessionId, firstRunId)
        await runtime.services.sessions.waitForRunSettled(sessionId, firstRunId)
      } finally {
        controller.signal.removeEventListener('abort', interruptFirstRun)
      }

      const approvalLimit = options.config.maxAutoPlanApprovals ?? 1
      while (
        completion.status === 'completed' &&
        !controller.signal.aborted &&
        metrics.goal?.status !== 'blocked' &&
        metrics.plan?.status === 'awaiting_review' &&
        autoPlanApprovals < approvalLimit
      ) {
        let updated
        try {
          updated = await runtime.services.sessions.updatePlanStatus({
            sessionId,
            status: 'active',
            source: 'headless:auto-plan-approval',
          })
        } catch (error) {
          incompleteReason = 'plan_approval_failed'
          options.onDiagnostic?.(
            'Headless automatic plan approval could not be persisted',
            error,
          )
          break
        }
        metrics.plan = updated.commit.change.session.plan ?? undefined
        const prompt = runtime.services.prompts.headlessPrompt(
          'autonomousPlanApproval',
          prepared.configStore.getPublicConfig().assistant.language,
        )
        const runId = runtime.services.sessions.startHarnessRun({
          sessionId,
          clientRequestId: `headless-plan-${autoPlanApprovals + 1}`,
          message: {
            kind: 'autonomous_plan_approval',
            text: prompt.content,
            source: 'headless:auto-plan-approval',
            promptId: prompt.resource.id,
            promptHash: prompt.resource.sha256,
          },
        })
        runIds.push(runId)
        autoPlanApprovals += 1
        writer.write({
          type: 'harness.auto_action',
          action: 'plan_approved',
          sessionId,
          runId,
          promptId: prompt.resource.id,
          promptHash: prompt.resource.sha256,
        })
        const interrupt = () => runtime.interrupt(sessionId!, runId)
        controller.signal.addEventListener('abort', interrupt, { once: true })
        try {
          completion = await runtime.events.waitForRun(sessionId, runId)
          await runtime.services.sessions.waitForRunSettled(sessionId, runId)
        } finally {
          controller.signal.removeEventListener('abort', interrupt)
        }
      }

      if (metrics.goal?.status === 'blocked') {
        incompleteReason = 'goal_blocked'
      } else if (metrics.plan?.status === 'awaiting_review') {
        incompleteReason = 'plan_approval_limit'
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', relayAbort)
    }

    if (sessionId) {
      await runtime.services.sessions.quiesceBackgroundTasks(sessionId)
    }
    const status = classifyStatus({ completion, timedOut, incompleteReason })
    const completedAt = new Date().toISOString()
    const resultPath = path.join(artifactsDirectory, 'result.json')
    const identityPath = path.join(artifactsDirectory, 'identity.json')
    const identity = createRuntimeIdentity({
      runtime,
      config: prepared.configStore.getPublicConfig(),
      configHash: prepared.configHash,
      taskDigest: sha256Json(options.task),
      sourceCommit: options.sourceCommit,
      sourceTree: options.sourceTree,
      runtimeImageDigest: options.runtimeImageDigest,
      swarmsEnabled: false,
    })
    const result: HeadlessResult = {
      schemaVersion: 2,
      status,
      sessionId: sessionId!,
      runIds,
      startedAt: startedAtDate.toISOString(),
      completedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      ...(metrics.finalResponse !== undefined
        ? { finalResponse: metrics.finalResponse }
        : {}),
      ...(incompleteReason ? { incompleteReason } : {}),
      configHash: prepared.configHash,
      autoPlanApprovals,
      usage: { ...metrics.usage },
      tools: { ...metrics.tools },
      artifacts: {
        resultPath,
        identityPath,
        tracePath: path.join(
          prepared.userDataDirectory,
          'traces',
          `${
            runtime.services.sessions.traceCaptureStatus(sessionId!)?.traceId ??
            'capture-unavailable'
          }.jsonl`,
        ),
        operationalLogDirectory,
      },
      ...(completion?.error ? { error: { ...completion.error } } : {}),
    }

    if (!validateResult(result)) {
      throw new Error(formatSchemaErrors(validateResult.errors))
    }
    if (!validateRuntimeIdentity(identity)) {
      throw new Error(formatSchemaErrors(validateRuntimeIdentity.errors))
    }
    await writeJsonAtomic(identityPath, identity)
    await writeJsonAtomic(resultPath, result)
    writer.write({ type: 'runtime.completed', status, resultPath })
    forwardRuntimeEvents = false
    return result
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', relayAbort)
    try {
      await backend.dispose()
    } catch (error) {
      headlessDiagnostic(
        'Headless backend cleanup did not fully complete',
        error,
      )
    }
    operationalLog.log({ level: 'info', event: 'backend.stopped' })
    stopProcessErrorCapture()
    try {
      await rm(databaseDirectory, { recursive: true, force: true })
    } catch (error) {
      headlessDiagnostic(
        'Headless temporary database cleanup did not fully complete',
        error,
      )
    }
  }
}

function classifyStatus(input: {
  completion: RunCompletion | undefined
  timedOut: boolean
  incompleteReason: HeadlessResult['incompleteReason']
}): HeadlessRunStatus {
  if (input.timedOut) return 'timed_out'
  if (input.incompleteReason) return 'needs_human_input'
  if (input.completion?.status === 'completed') return 'completed'
  if (input.completion?.status === 'cancelled') return 'cancelled'
  return 'failed'
}

function assertArtifactsOutsideWorkspace(
  workspace: string,
  artifactsDirectory: string,
): void {
  const relative = path.relative(workspace, artifactsDirectory)
  const reverseRelative = path.relative(artifactsDirectory, workspace)
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative)) ||
    (!reverseRelative.startsWith(`..${path.sep}`) &&
      reverseRelative !== '..' &&
      !path.isAbsolute(reverseRelative))
  ) {
    throw new HeadlessRunInputError(
      'Artifacts directory must be outside the workspace',
    )
  }
}

async function resolvePromptDirectory(explicit?: string): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    explicit,
    process.env.ZCH_PROMPT_DIRECTORY,
    path.resolve('resources', 'prompts'),
    path.resolve(moduleDirectory, '..', 'resources', 'prompts'),
    path.resolve(moduleDirectory, '..', '..', 'resources', 'prompts'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next host layout.
    }
  }
  throw new HeadlessRunInputError('Prompt resource directory is unavailable')
}
