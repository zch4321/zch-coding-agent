import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { AutoApprover } from '../permission/auto-approver'
import { RuntimeIdentitySchema } from '../../shared/runtime-identity'
import type { RuntimeIdentity } from '../../shared/runtime-identity'
import type { LLMProvider } from '../providers/provider'
import { createBackendRuntime } from '../application/create-backend-runtime'
import { createRuntimeIdentity, sha256Json } from '../runtime/runtime-identity'
import type { RunCompletion } from '../runtime/runtime-events'
import type { RuntimeEventListener } from '../runtime/runtime-events'
import type { BenchmarkAgentCase } from '../../shared/benchmark'
import type { ProjectId, SessionId } from '../../shared/ids'
import { getProviderConfig } from '../../shared/config'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { writeJsonAtomic } from '../config/atomic-file'
import { prepareHeadlessConfig } from './config'
import {
  HeadlessResultSchema,
  type HeadlessConfig,
  type HeadlessBenchmarkController,
  type HeadlessResult,
  type HeadlessRunStatus,
} from './contracts'
import { HeadlessEventWriter, HeadlessRunMetrics } from './event-stream'
import { collectWorkspacePatch } from './patch'

const validateResult = compileSchema(HeadlessResultSchema)
const validateRuntimeIdentity = compileSchema(RuntimeIdentitySchema)

/** Reports headless run input failures. */
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
  }) => LLMProvider
  autoApproverFactory?: (options: {
    config: ReturnType<import('../config/store').ConfigStore['getPublicConfig']>
    apiKey: string
  }) => AutoApprover
  onDiagnostic?: (message: string, error?: unknown) => void
  sourceCommit?: string
  sourceTree?: RuntimeIdentity['sourceTree']
  runtimeImageDigest?: string
  eventListeners?: RuntimeEventListener[]
  benchmarkController?: HeadlessBenchmarkController
  benchmarkCase?: BenchmarkAgentCase
}

/** Runs headless agent. */
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
  const backend = await createBackendRuntime({
    configStore: prepared.configStore,
    databasePath: path.join(databaseDirectory, 'agent.db'),
    runtimeDataDirectory: prepared.userDataDirectory,
    promptDirectory: await resolvePromptDirectory(options.promptDirectory),
    fetchImpl: options.fetchImpl,
    providerFactory: options.providerFactory,
    autoApproverFactory: options.autoApproverFactory,
    eventListeners: [metricsListener, ...(options.eventListeners ?? [])],
    onDiagnostic: options.onDiagnostic,
  }).catch(async (error: unknown) => {
    await rm(databaseDirectory, { recursive: true, force: true })
    throw error
  })
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
  let initialRunIds: HeadlessResult['runIds'] | undefined
  const repairRunIds: HeadlessResult['runIds'] = []
  let repairAttempted = false
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
      const firstRun = await backend.runs.start(
        {
          version: 1,
          kind: 'new_session',
          sessionId,
          projectId: project.id as ProjectId,
          modelSelection: {
            providerId: provider.id,
            model: provider.model,
            reasoning: resolvedProvider.reasoning,
          },
          permissionMode: 'yolo',
          message: options.task,
          clientRequestId: 'headless-task-1',
        },
        {
          ...(options.benchmarkCase
            ? {
                harnessContexts: [
                  {
                    kind: 'benchmark_case' as const,
                    text: JSON.stringify(options.benchmarkCase, null, 2),
                    source: `benchmark:${options.benchmarkCase.suiteId}/${options.benchmarkCase.caseId}`,
                  },
                ],
              }
            : {}),
        },
      )
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
        const updated = await runtime.services.sessions.updatePlanStatus({
          sessionId,
          status: 'active',
          source: 'headless:auto-plan-approval',
        })
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
      initialRunIds = [...runIds]
      if (
        options.benchmarkController &&
        !timedOut &&
        !incompleteReason &&
        !controller.signal.aborted
      ) {
        if (timeout) clearTimeout(timeout)
        const initialStatus = classifyStatus({
          completion,
          timedOut,
          incompleteReason,
        })
        writer.write({
          type: 'benchmark.phase_ready',
          protocol: 'repair-once',
          phase: 'initial',
          status: initialStatus,
          sessionId,
          runIds: [...initialRunIds],
          usage: { ...metrics.usage },
          tools: { ...metrics.tools },
        })
        const decision = await options.benchmarkController.waitForDecision({
          signal: controller.signal,
        })
        if (decision.action === 'repair') {
          repairAttempted = true
          const runId = runtime.services.sessions.startHarnessRun({
            sessionId,
            clientRequestId: 'headless-benchmark-repair-1',
            message: {
              kind: 'benchmark_feedback',
              text: `Visibility: ${decision.feedback.visibility}\n${decision.feedback.text}`,
              source: 'headless:benchmark-repair',
            },
          })
          runIds.push(runId)
          repairRunIds.push(runId)
          armTimeout()
          const interrupt = () => runtime.interrupt(sessionId!, runId)
          controller.signal.addEventListener('abort', interrupt, { once: true })
          try {
            completion = await runtime.events.waitForRun(sessionId, runId)
            await runtime.services.sessions.waitForRunSettled(sessionId, runId)
          } finally {
            controller.signal.removeEventListener('abort', interrupt)
          }
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', relayAbort)
    }

    const status = classifyStatus({ completion, timedOut, incompleteReason })
    const patch = await collectWorkspacePatch({ workspace, artifactsDirectory })
    const completedAt = new Date().toISOString()
    const resultPath = path.join(artifactsDirectory, 'result.json')
    const identityPath = path.join(artifactsDirectory, 'identity.json')
    const identity = createRuntimeIdentity({
      runtime,
      config: prepared.configStore.getPublicConfig(),
      configHash: prepared.configHash,
      caseDigest: options.config.caseDigest ?? sha256Json(options.task),
      sourceCommit: options.sourceCommit,
      sourceTree: options.sourceTree,
      runtimeImageDigest: options.runtimeImageDigest,
    })
    const result: HeadlessResult = {
      schemaVersion: 1,
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
      ...(options.benchmarkController
        ? {
            benchmark: {
              protocol: 'repair-once' as const,
              repairAttempted,
              initialRunIds: initialRunIds ?? [...runIds],
              repairRunIds,
            },
          }
        : {}),
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
        ...(patch.path ? { patchPath: patch.path } : {}),
        patchStatus: patch.status,
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
    await backend.dispose()
    await rm(databaseDirectory, { recursive: true, force: true })
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
