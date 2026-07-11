import { access, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { AutoApprover } from '../permission/auto-approver'
import { RuntimeIdentitySchema } from '../../shared/runtime-identity'
import type { RuntimeIdentity } from '../../shared/runtime-identity'
import type { LLMProvider } from '../providers/provider'
import { createAgentRuntime } from '../runtime/create-agent-runtime'
import { createRuntimeIdentity, sha256Json } from '../runtime/runtime-identity'
import type { RunCompletion } from '../runtime/runtime-events'
import type { RuntimeEventListener } from '../runtime/runtime-events'
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
import { collectWorkspacePatch } from './patch'

const validateResult = compileSchema(HeadlessResultSchema)
const validateRuntimeIdentity = compileSchema(RuntimeIdentitySchema)

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
}

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
  const writer = new HeadlessEventWriter(options.output)
  const metrics = new HeadlessRunMetrics(writer)
  const runtime = await createAgentRuntime({
    configStore: prepared.configStore,
    userDataDirectory: prepared.userDataDirectory,
    promptDirectory: await resolvePromptDirectory(options.promptDirectory),
    fetchImpl: options.fetchImpl,
    providerFactory: options.providerFactory,
    autoApproverFactory: options.autoApproverFactory,
    eventListeners: [metrics, ...(options.eventListeners ?? [])],
    onDiagnostic: options.onDiagnostic,
  })
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = () =>
    controller.abort(
      options.signal?.reason ?? new Error('Headless run cancelled'),
    )
  options.signal?.addEventListener('abort', relayAbort, { once: true })
  const timeout = setTimeout(
    () => {
      timedOut = true
      controller.abort(new Error('Headless run timed out'))
    },
    Math.max(1, options.timeoutMs),
  )
  timeout.unref()

  const provider = options.config.provider
  writer.write({
    type: 'runtime.started',
    workspace,
    providerId: provider.id,
    model: provider.model,
    permissionMode: 'yolo',
    configHash: prepared.configHash,
  })

  let sessionId: Awaited<ReturnType<typeof runtime.createSession>> | undefined
  const runIds: HeadlessResult['runIds'] = []
  let completion: RunCompletion | undefined
  let autoPlanApprovals = 0
  let incompleteReason: HeadlessResult['incompleteReason']

  try {
    try {
      sessionId = await runtime.createSession({
        workspace,
        mode: 'yolo',
        provider: provider.id,
      })
      const firstRun = runtime.run({
        sessionId,
        message: options.task,
        clientRequestId: 'headless-task-1',
        signal: controller.signal,
      })
      runIds.push(firstRun.runId)
      completion = await firstRun.completion

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
        if (!updated.accepted) break
        metrics.plan = updated.plan
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
      clearTimeout(timeout)
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
      artifacts: {
        resultPath,
        identityPath,
        tracePath: path.join(
          prepared.userDataDirectory,
          'traces',
          `${sessionId!}.jsonl`,
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
    await runtime.closeSession(sessionId)
    writer.write({ type: 'runtime.completed', status, resultPath })
    return result
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', relayAbort)
    if (sessionId) await runtime.closeSession(sessionId).catch(() => false)
    await runtime.dispose()
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
