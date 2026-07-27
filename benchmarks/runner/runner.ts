import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent } from '../../shared/agent-events'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import {
  HeadlessResultSchema,
  HeadlessStreamEventSchema,
  type HeadlessResult,
  type HeadlessStreamEvent,
} from '../../electron/headless/contracts'
import {
  TraceEventSchema,
  type TraceEvent,
} from '../../electron/logging/events'
import { compileSchema } from '../../electron/schema-validator'
import { sha256Bytes } from '../cases/hash'
import {
  ISOLATED_GRADER_REVISION,
  type IsolatedGraderRunResult,
} from '../grader/contracts'
import {
  runIsolatedGrader,
  type IsolatedGraderRunner,
} from '../grader/coordinator'
import { scoreIsolatedGrader } from '../grader/scoring'
import { inspectWorkerImage } from '../worker/capabilities'
import { runDockerWorker } from '../worker/coordinator'
import type { DockerWorkerRunInput } from '../worker/contracts'
import type {
  BenchmarkFeedbackVisibility,
  BenchmarkEvaluationResult,
  BenchmarkHardGate,
  BenchmarkMetricSnapshot,
  BenchmarkTrialIdentity,
  BenchmarkTrialResult,
  BenchmarkTrialsResult,
  DockerWorkerRunner,
  RunBenchmarkTrialsInput,
} from './contracts'
import { createBenchmarkFeedback } from './feedback'
import { benchmarkSessionTranscriptMarkdown } from './session-transcript-artifact'
import {
  aggregateBenchmarkMetrics,
  validateBenchmarkPriceSnapshot,
} from '../metrics/aggregate'

const MAX_TRIALS = 100
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_LEAK_SCAN_BYTES = 64 * 1024 * 1024
const validateHeadlessResult = compileSchema(HeadlessResultSchema)
const validateTraceEvent = compileSchema(TraceEventSchema)
const validateHeadlessStreamEvent = compileSchema(HeadlessStreamEventSchema)

interface AttemptCapture {
  patch: string
  grader: IsolatedGraderRunResult
  evaluation: BenchmarkEvaluationResult
  directory: string
}

interface CompleteMarker {
  schemaVersion: 1
  identitySha256: string
  resultSha256: string
  artifactsSha256: string
}

/** Runs the configured benchmark trials and persists restricted session artifacts and summaries. */
export async function runBenchmarkTrials(
  input: RunBenchmarkTrialsInput,
): Promise<BenchmarkTrialsResult> {
  const protocol = input.protocol ?? 'strict'
  const trials = input.trials ?? 1
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > MAX_TRIALS) {
    throw new Error(`Benchmark trials must be between 1 and ${MAX_TRIALS}`)
  }
  const feedbackVisibility = validateProtocol(input, protocol)
  const effectiveConfig = effectiveHeadlessConfig(input)
  const runtimeImageDigest = await resolveRuntimeImageDigest(input)
  await mkdir(input.outputDirectory, { recursive: true })
  const results: BenchmarkTrialsResult['trials'] = []
  try {
    for (let trialIndex = 1; trialIndex <= trials; trialIndex += 1) {
      if (input.signal?.aborted) throw new Error('Benchmark run was cancelled')
      emitProgress(input, {
        phase: 'trial-start',
        trialIndex,
        trialCount: trials,
      })
      const identity = createTrialIdentity({
        input,
        protocol,
        feedbackVisibility,
        effectiveConfig,
        runtimeImageDigest,
        trialIndex,
      })
      const startedMs = performance.now()
      const trial = await runTrial({
        input,
        protocol,
        feedbackVisibility,
        effectiveConfig,
        runtimeImageDigest,
        identity,
      })
      results.push(trial)
      const evaluation =
        trial.result.afterFeedback?.evaluation ??
        trial.result.initial.evaluation
      emitProgress(input, {
        phase: 'trial-complete',
        trialIndex,
        trialCount: trials,
        reused: trial.reused,
        resolved: trial.result.resolvedAfterFeedback,
        level: evaluation.level,
        durationMs: trial.reused
          ? 0
          : Math.max(0, performance.now() - startedMs),
      })
    }
  } finally {
    await input.adapter.disposeCaseResources?.(input.loadedCase)
  }
  return { schemaVersion: 1, protocol, trials: results }
}

function emitProgress(
  input: RunBenchmarkTrialsInput,
  event: Parameters<NonNullable<RunBenchmarkTrialsInput['onProgress']>>[0],
): void {
  try {
    input.onProgress?.(event)
  } catch {
    // Progress reporting must never change the benchmark outcome.
  }
}

async function runTrial(input: {
  input: RunBenchmarkTrialsInput
  protocol: 'strict' | 'repair-once'
  feedbackVisibility?: BenchmarkFeedbackVisibility
  effectiveConfig: RunBenchmarkTrialsInput['config']
  runtimeImageDigest: string
  identity: BenchmarkTrialIdentity
}): Promise<BenchmarkTrialsResult['trials'][number]> {
  const trialName = `trial-${String(input.identity.trialIndex).padStart(4, '0')}`
  const finalDirectory = path.resolve(input.input.outputDirectory, trialName)
  const identitySha256 = sha256Canonical(input.identity)
  const resumed = await readCompletedTrial(finalDirectory, identitySha256)
  if (resumed)
    return {
      directory: finalDirectory,
      identity: input.identity,
      result: resumed,
      reused: true,
    }
  if (await exists(finalDirectory)) {
    throw new Error(`Benchmark trial directory is incomplete: ${trialName}`)
  }

  const stagingDirectory = path.resolve(
    input.input.outputDirectory,
    `.${trialName}.incomplete-${randomUUID()}`,
  )
  const workspace = path.join(stagingDirectory, 'workspace')
  const workerArtifacts = path.join(stagingDirectory, 'worker')
  const attemptsDirectory = path.join(stagingDirectory, 'attempts')
  await Promise.all([
    mkdir(workerArtifacts, { recursive: true }),
    mkdir(attemptsDirectory, { recursive: true }),
  ])
  const preparedWorkspace = await input.input.adapter.prepareWorkspace({
    loadedCase: input.input.loadedCase,
    destination: workspace,
  })
  await writeJsonAtomic(
    path.join(stagingDirectory, 'trial-identity.json'),
    input.identity,
  )

  let initial: AttemptCapture | undefined
  let initialMetrics: BenchmarkMetricSnapshot | undefined
  let repairAttempted = false
  let phaseCount = 0
  const workerRunner = input.input.workerRunner ?? runDockerWorker
  const workerInput: DockerWorkerRunInput = {
    image: input.input.image,
    proxyImage: input.input.proxyImage,
    workspace: preparedWorkspace.mount ?? {
      kind: 'bind',
      directory: preparedWorkspace.directory,
    },
    workspaceDirectory: preparedWorkspace.directory,
    artifactsDirectory: workerArtifacts,
    config: input.effectiveConfig,
    task: input.input.loadedCase.manifest.task,
    benchmarkCase: input.input.adapter.toAgentCaseDescriptor(
      input.input.loadedCase,
    ),
    credential: input.input.credential,
    expectedSourceCommit: input.input.expectedSourceCommit,
    caseDigest: sha256Canonical(input.input.loadedCase.identity),
    limits: workerLimits(input.input),
    signal: input.input.signal,
  }
  if (input.protocol === 'repair-once') {
    workerInput.benchmarkControl = {
      protocol: 'repair-once',
      onPhaseReady: async (phase) => {
        phaseCount += 1
        if (phaseCount !== 1) {
          throw new Error('Headless worker emitted more than one initial phase')
        }
        initialMetrics = {
          usage: { ...phase.usage },
          tools: { ...phase.tools },
        }
        initial = await captureAttempt({
          loadedCase: input.input.loadedCase,
          workspace: preparedWorkspace,
          adapter: input.input.adapter,
          directory: path.join(attemptsDirectory, 'initial'),
          image: input.input.image,
          imageDigest: input.runtimeImageDigest,
          expectedSourceCommit: input.input.expectedSourceCommit,
          signal: input.input.signal,
          graderRunner: input.input.graderRunner ?? runIsolatedGrader,
        })
        if (
          initial.evaluation.resolved ||
          initial.evaluation.status === 'invalid' ||
          initial.evaluation.status === 'unsupported'
        ) {
          return { schemaVersion: 1, action: 'finish' }
        }
        repairAttempted = true
        return {
          schemaVersion: 1,
          action: 'repair',
          feedback: {
            visibility: input.feedbackVisibility!,
            text: createBenchmarkFeedback({
              evaluation: initial.evaluation,
              visibility: input.feedbackVisibility!,
            }),
          },
        }
      },
    }
  }

  const worker = await workerRunner(workerInput)
  if (worker.image && worker.image.digest !== input.runtimeImageDigest) {
    throw new Error('Docker worker image digest changed during the trial')
  }
  if (!initial) {
    initial = await captureAttempt({
      loadedCase: input.input.loadedCase,
      workspace: preparedWorkspace,
      adapter: input.input.adapter,
      directory: path.join(attemptsDirectory, 'initial'),
      image: input.input.image,
      imageDigest: input.runtimeImageDigest,
      expectedSourceCommit: input.input.expectedSourceCommit,
      signal: input.input.signal,
      graderRunner: input.input.graderRunner ?? runIsolatedGrader,
      skipGraderStatus:
        worker.status === 'unsupported'
          ? 'unsupported'
          : worker.status === 'invalid'
            ? 'invalid'
            : undefined,
    })
  }
  const headless = await readHeadlessResult(workerArtifacts)
  const cumulativeMetrics = headless
    ? { usage: { ...headless.usage }, tools: { ...headless.tools } }
    : undefined
  let afterFeedback: AttemptCapture | undefined
  if (repairAttempted) {
    afterFeedback = await captureAttempt({
      loadedCase: input.input.loadedCase,
      workspace: preparedWorkspace,
      adapter: input.input.adapter,
      directory: path.join(attemptsDirectory, 'after-feedback'),
      image: input.input.image,
      imageDigest: input.runtimeImageDigest,
      expectedSourceCommit: input.input.expectedSourceCommit,
      signal: input.input.signal,
      graderRunner: input.input.graderRunner ?? runIsolatedGrader,
    })
  }

  const trialGates = createTrialGates({
    worker,
    headless,
    expectedImageDigest: input.runtimeImageDigest,
    trustedTestWorker: Boolean(input.input.workerRunner),
  })
  await finalizeAttempt(initial, input.input.loadedCase, trialGates)
  if (afterFeedback) {
    await finalizeAttempt(afterFeedback, input.input.loadedCase, trialGates)
  }

  const trace = await readBenchmarkTrace(workerArtifacts)
  const agentEvents = await readBenchmarkAgentEvents(workerArtifacts)
  const metrics =
    headless && trace
      ? aggregateBenchmarkMetrics({
          trace,
          agentEvents,
          patch: (afterFeedback ?? initial).patch,
          durationMs: headless.durationMs,
          priceSnapshot: input.input.priceSnapshot,
        })
      : undefined
  const sessionTranscriptMarkdown = trace
    ? benchmarkSessionTranscriptMarkdown({ trace })
    : undefined

  const result: BenchmarkTrialResult = {
    schemaVersion: 1,
    identitySha256,
    trialIndex: input.identity.trialIndex,
    protocol: input.protocol,
    workerRunId: worker.runId,
    workerStatus: worker.status,
    sessionId: headless?.sessionId,
    metrics,
    ...(sessionTranscriptMarkdown
      ? {
          artifacts: {
            sessionTranscript: 'session-transcript.restricted.md',
          },
        }
      : {}),
    initial: { evaluation: initial.evaluation, metrics: initialMetrics },
    afterFeedback: afterFeedback
      ? {
          evaluation: afterFeedback.evaluation,
          incrementalMetrics:
            initialMetrics && cumulativeMetrics
              ? subtractMetrics(cumulativeMetrics, initialMetrics)
              : undefined,
          cumulativeMetrics,
        }
      : undefined,
    repairAttempted,
    resolvedInitial: initial.evaluation.resolved,
    resolvedAfterFeedback:
      afterFeedback?.evaluation.resolved ?? initial.evaluation.resolved,
    recovered:
      !initial.evaluation.resolved &&
      Boolean(afterFeedback?.evaluation.resolved),
    completedAt: new Date().toISOString(),
  }
  await rm(workspace, { recursive: true, force: true })
  if (metrics) {
    await writeJsonAtomic(path.join(stagingDirectory, 'metrics.json'), metrics)
  }
  if (sessionTranscriptMarkdown) {
    await writeFile(
      path.join(stagingDirectory, 'session-transcript.restricted.md'),
      sessionTranscriptMarkdown,
      'utf8',
    )
  }
  if (input.input.priceSnapshot) {
    await writeJsonAtomic(
      path.join(stagingDirectory, 'price-snapshot.json'),
      input.input.priceSnapshot,
    )
  }
  let leakScan: Awaited<ReturnType<typeof scanArtifactsForCredential>>
  try {
    leakScan = await scanArtifactsForCredential({
      directory: stagingDirectory,
      credential:
        input.input.credential.mode === 'proxy'
          ? input.input.credential.upstreamCredential
          : input.input.credential.credential,
      excludedFiles: new Set(['session-transcript.restricted.md']),
    })
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
  await writeJsonAtomic(path.join(stagingDirectory, 'leak-scan.json'), leakScan)
  const resultPath = path.join(stagingDirectory, 'trial-result.json')
  await writeJsonAtomic(resultPath, result)
  const resultSha256 = sha256Bytes(await readFile(resultPath))
  const artifactsSha256 = await hashArtifactDirectory(stagingDirectory)
  await writeJsonAtomic(path.join(stagingDirectory, 'complete.json'), {
    schemaVersion: 1,
    identitySha256,
    resultSha256,
    artifactsSha256,
  } satisfies CompleteMarker)
  await rename(stagingDirectory, finalDirectory)
  return {
    directory: finalDirectory,
    identity: input.identity,
    result,
    reused: false,
  }
}

async function captureAttempt(input: {
  loadedCase: RunBenchmarkTrialsInput['loadedCase']
  workspace: import('../adapters/contracts').BenchmarkPreparedWorkspace
  adapter: import('../adapters/contracts').BenchmarkCaseAdapter
  directory: string
  image: string
  imageDigest: string
  expectedSourceCommit?: string
  signal?: AbortSignal
  graderRunner: IsolatedGraderRunner
  skipGraderStatus?: 'unsupported' | 'invalid'
}): Promise<AttemptCapture> {
  await mkdir(input.directory, { recursive: true })
  let patch = ''
  let grader: IsolatedGraderRunResult | undefined
  try {
    patch = await input.adapter.capturePatch({
      loadedCase: input.loadedCase,
      workspace: input.workspace,
    })
  } catch {
    grader = failedGraderRun({
      patch,
      imageDigest: input.imageDigest,
      artifactsDirectory: path.join(input.directory, 'grader'),
      status: 'attempted',
      code: 'BENCHMARK_PATCH_CAPTURE_FAILED',
      message: 'The submitted patch could not be captured for grading',
    })
  }
  if (!grader && input.skipGraderStatus) {
    grader = failedGraderRun({
      patch,
      imageDigest: input.imageDigest,
      artifactsDirectory: path.join(input.directory, 'grader'),
      status: input.skipGraderStatus,
      code:
        input.skipGraderStatus === 'unsupported'
          ? 'BENCHMARK_WORKER_UNSUPPORTED'
          : 'BENCHMARK_WORKER_INVALID',
      message: 'The Agent worker could not produce a gradeable attempt',
    })
  }
  if (!grader) {
    try {
      grader = await input.adapter.runGrader(
        {
          loadedCase: input.loadedCase,
          patch,
          image: input.image,
          expectedImageDigest: input.imageDigest,
          expectedSourceCommit: input.expectedSourceCommit,
          artifactsDirectory: path.join(input.directory, 'grader'),
          signal: input.signal,
        },
        input.graderRunner,
      )
    } catch {
      grader = failedGraderRun({
        patch,
        imageDigest: input.imageDigest,
        artifactsDirectory: path.join(input.directory, 'grader'),
        status: 'invalid',
        code: 'BENCHMARK_GRADER_COORDINATOR_FAILED',
        message: 'The isolated grader coordinator failed unexpectedly',
      })
    }
  }
  const evaluation = scoreIsolatedGrader({
    loadedCase: input.loadedCase,
    grader,
  })
  await Promise.all([
    writeFile(path.join(input.directory, 'patch.diff'), patch, 'utf8'),
    writeJsonAtomic(path.join(input.directory, 'evaluation.json'), evaluation),
    writeJsonAtomic(path.join(input.directory, 'redaction.json'), {
      schemaVersion: 1,
      shareableReport: 'evaluation.json',
      restrictedArtifacts: [
        'grader/coordinator-result.restricted.json',
        ...(grader.artifacts.rawReportPath
          ? ['grader/raw-report.restricted.json']
          : []),
      ],
      removedFields: [
        'graderInput',
        'privateCheckIds',
        'privateCommands',
        'commandStdout',
        'commandStderr',
      ],
    }),
  ])
  return { patch, grader, evaluation, directory: input.directory }
}

async function finalizeAttempt(
  attempt: AttemptCapture,
  loadedCase: RunBenchmarkTrialsInput['loadedCase'],
  additionalGates: BenchmarkHardGate[],
): Promise<void> {
  attempt.evaluation = scoreIsolatedGrader({
    loadedCase,
    grader: attempt.grader,
    additionalGates,
  })
  await writeJsonAtomic(
    path.join(attempt.directory, 'evaluation.json'),
    attempt.evaluation,
  )
}

function createTrialGates(input: {
  worker: Awaited<ReturnType<DockerWorkerRunner>>
  headless?: HeadlessResult
  expectedImageDigest: string
  trustedTestWorker: boolean
}): BenchmarkHardGate[] {
  const executionBoundary =
    input.trustedTestWorker ||
    Boolean(
      input.worker.capability &&
      input.worker.image &&
      input.worker.sandbox &&
      Object.values(input.worker.sandbox).every(Boolean),
    )
  const runtimeIdentity =
    input.trustedTestWorker ||
    input.worker.image?.digest === input.expectedImageDigest
  const cleanup = Object.values(input.worker.cleanup).every(Boolean)
  return [
    {
      id: 'agent_execution_boundary',
      passed: executionBoundary,
      owner: 'infrastructure',
    },
    {
      id: 'agent_result_valid',
      passed: input.trustedTestWorker || Boolean(input.headless),
      owner: 'infrastructure',
    },
    {
      id: 'runtime_identity',
      passed: runtimeIdentity,
      owner: 'infrastructure',
    },
    {
      id: 'worker_cleanup',
      passed: cleanup,
      owner: 'infrastructure',
    },
    { id: 'credential_clean', passed: true, owner: 'infrastructure' },
  ]
}

function failedGraderRun(input: {
  patch: string
  imageDigest: string
  artifactsDirectory: string
  status: 'attempted' | 'invalid' | 'unsupported'
  code: string
  message: string
}): IsolatedGraderRunResult {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    status: input.status,
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: input.imageDigest,
    inputSha256: sha256Bytes(''),
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    patch: {
      sha256: sha256Bytes(input.patch),
      present: Boolean(input.patch),
      applies: false,
      scopeCompliant: false,
      hygienePassed: false,
    },
    sandbox: {
      networkDisabled: false,
      readOnlyRoot: false,
      nonRoot: false,
      capabilitiesDropped: false,
      noNewPrivileges: false,
      boundedResources: false,
      privateInputReadOnly: false,
      dockerSocketAbsent: false,
    },
    inputImmutable: false,
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: input.artifactsDirectory,
      stdoutPath: path.join(input.artifactsDirectory, 'stdout.log'),
      stderrPath: path.join(input.artifactsDirectory, 'stderr.log'),
      coordinatorResultPath: path.join(
        input.artifactsDirectory,
        'coordinator-result.restricted.json',
      ),
    },
    error: {
      code: input.code,
      message: input.message,
    },
  }
}

async function readCompletedTrial(
  directory: string,
  expectedIdentitySha256: string,
): Promise<BenchmarkTrialResult | undefined> {
  if (!(await exists(directory))) return undefined
  try {
    const marker = await readJsonBounded<CompleteMarker>(
      path.join(directory, 'complete.json'),
    )
    if (
      marker.schemaVersion !== 1 ||
      marker.identitySha256 !== expectedIdentitySha256
    ) {
      throw new Error('identity mismatch')
    }
    const resultPath = path.join(directory, 'trial-result.json')
    const resultRaw = await readFile(resultPath)
    if (
      sha256Bytes(resultRaw) !== marker.resultSha256 ||
      (await hashArtifactDirectory(directory)) !== marker.artifactsSha256
    ) {
      throw new Error('artifact checksum mismatch')
    }
    const result = JSON.parse(
      resultRaw.toString('utf8'),
    ) as BenchmarkTrialResult
    if (
      result.schemaVersion !== 1 ||
      result.identitySha256 !== expectedIdentitySha256
    ) {
      throw new Error('result identity mismatch')
    }
    return result
  } catch (error) {
    throw new Error(
      `Completed benchmark trial is not reusable: ${
        error instanceof Error ? error.message : 'invalid artifact'
      }`,
      { cause: error },
    )
  }
}

async function hashArtifactDirectory(directory: string): Promise<string> {
  const files = await listFiles(directory)
  const records: string[] = []
  for (const relative of files.filter((file) => file !== 'complete.json')) {
    records.push(
      `${relative}\0${sha256Bytes(await readFile(path.join(directory, relative)))}`,
    )
  }
  return sha256Bytes(records.join('\n'))
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const pending = ['.']
  while (pending.length > 0) {
    const relative = pending.pop()!
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const nested = relative === '.' ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('Artifact contains a symlink')
      if (entry.isDirectory()) pending.push(nested)
      else if (entry.isFile()) files.push(nested.replaceAll('\\', '/'))
    }
  }
  return files.sort()
}

/** Recursively scans artifact files for a credential, excluding explicitly allowed files. */
export async function scanArtifactsForCredential(input: {
  directory: string
  credential: string
  excludedFiles?: ReadonlySet<string>
}): Promise<{
  schemaVersion: 1
  filesScanned: number
  bytesScanned: number
  sensitiveMatches: 0
}> {
  const needle = Buffer.from(input.credential, 'utf8')
  if (needle.byteLength === 0) throw new Error('Benchmark credential is empty')
  const files = (await listFiles(input.directory)).filter(
    (relative) => !input.excludedFiles?.has(relative),
  )
  let bytesScanned = 0
  for (const relative of files) {
    const content = await readFile(path.join(input.directory, relative))
    bytesScanned += content.byteLength
    if (bytesScanned > MAX_LEAK_SCAN_BYTES) {
      throw new Error('Benchmark artifact leak scan exceeded its byte limit')
    }
    if (content.indexOf(needle) >= 0) {
      throw new Error(`Benchmark credential leaked into artifact: ${relative}`)
    }
  }
  return {
    schemaVersion: 1,
    filesScanned: files.length,
    bytesScanned,
    sensitiveMatches: 0,
  }
}

async function readHeadlessResult(
  artifactsDirectory: string,
): Promise<HeadlessResult | undefined> {
  try {
    const raw = await readFile(path.join(artifactsDirectory, 'result.json'))
    if (raw.byteLength > MAX_RESULT_BYTES) return undefined
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return validateHeadlessResult(value) ? (value as HeadlessResult) : undefined
  } catch {
    return undefined
  }
}

async function readBenchmarkTrace(
  artifactsDirectory: string,
): Promise<TraceEvent[] | undefined> {
  try {
    const files = (await listFiles(artifactsDirectory)).filter(
      (file) =>
        file.endsWith('.jsonl') &&
        (file.includes('/traces/') || file === 'trace.jsonl'),
    )
    if (files.length !== 1) return undefined
    const values = await readJsonLinesBounded(
      path.join(artifactsDirectory, files[0]!),
    )
    if (!values.every((value) => validateTraceEvent(value))) return undefined
    return values as TraceEvent[]
  } catch {
    return undefined
  }
}

async function readBenchmarkAgentEvents(
  artifactsDirectory: string,
): Promise<AgentEvent[] | undefined> {
  try {
    const values = await readJsonLinesBounded(
      path.join(artifactsDirectory, 'stdout.jsonl'),
    )
    if (!values.every((value) => validateHeadlessStreamEvent(value))) {
      return undefined
    }
    return (values as HeadlessStreamEvent[]).flatMap((event) =>
      event.type === 'agent.event' ? [event.event] : [],
    )
  } catch {
    return undefined
  }
}

async function readJsonLinesBounded(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath)
  if (raw.byteLength > MAX_LEAK_SCAN_BYTES) {
    throw new Error('Benchmark JSONL artifact exceeds its byte limit')
  }
  return raw
    .toString('utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

function subtractMetrics(
  cumulative: BenchmarkMetricSnapshot,
  initial: BenchmarkMetricSnapshot,
): BenchmarkMetricSnapshot {
  return {
    usage: mapNumericDifference(cumulative.usage, initial.usage),
    tools: mapNumericDifference(cumulative.tools, initial.tools),
  }
}

function mapNumericDifference<T extends Record<string, number>>(
  cumulative: T,
  initial: T,
): T {
  return Object.fromEntries(
    Object.keys(cumulative).map((key) => [
      key,
      Math.max(0, cumulative[key]! - initial[key]!),
    ]),
  ) as T
}

function validateProtocol(
  input: RunBenchmarkTrialsInput,
  protocol: 'strict' | 'repair-once',
): BenchmarkFeedbackVisibility | undefined {
  if (protocol === 'strict') return undefined
  const policy = input.loadedCase.manifest.feedbackPolicy
  if (!policy.repairOnceAllowed || policy.allowed === 'none') {
    throw new Error('This benchmark case does not allow repair-once feedback')
  }
  const visibility = input.feedbackVisibility ?? 'public'
  if (visibility === 'diagnostic' && policy.allowed !== 'diagnostic') {
    throw new Error('This benchmark case does not allow diagnostic feedback')
  }
  return visibility
}

function effectiveHeadlessConfig(
  input: RunBenchmarkTrialsInput,
): RunBenchmarkTrialsInput['config'] {
  const resources = input.loadedCase.manifest.resources
  const config = structuredClone(input.config)
  config.limits = {
    ...config.limits,
    maxStepsPerRun:
      !config.limits?.maxStepsPerRun ||
      config.limits.maxStepsPerRun > resources.maxAgentSteps
        ? resources.maxAgentSteps
        : config.limits.maxStepsPerRun,
    maxContextTokens: Math.min(
      config.limits?.maxContextTokens ?? resources.maxContextTokens,
      resources.maxContextTokens,
    ),
  }
  return config
}

function workerLimits(
  input: RunBenchmarkTrialsInput,
): DockerWorkerRunInput['limits'] {
  const resources = input.loadedCase.manifest.resources
  return {
    wallTimeMs: resources.wallTimeMs,
    cpus: resources.cpus,
    memoryBytes: resources.memoryBytes,
    pids: resources.pids,
    diskBytes: resources.diskBytes,
  }
}

function createTrialIdentity(input: {
  input: RunBenchmarkTrialsInput
  protocol: 'strict' | 'repair-once'
  feedbackVisibility?: BenchmarkFeedbackVisibility
  effectiveConfig: RunBenchmarkTrialsInput['config']
  runtimeImageDigest: string
  trialIndex: number
}): BenchmarkTrialIdentity {
  const manifest = input.input.loadedCase.manifest
  const provider = input.effectiveConfig.provider
  if (input.input.priceSnapshot) {
    validateBenchmarkPriceSnapshot(input.input.priceSnapshot)
  }
  if (
    input.input.priceSnapshot &&
    (input.input.priceSnapshot.providerId !== provider.id ||
      input.input.priceSnapshot.model !== provider.model)
  ) {
    throw new Error(
      'Benchmark price snapshot provider/model does not match the trial config',
    )
  }
  const priceSnapshotSha256 = input.input.priceSnapshot
    ? sha256Canonical(input.input.priceSnapshot)
    : undefined
  return {
    schemaVersion: 1,
    suiteId: manifest.suite.id,
    suiteRevision: manifest.suite.revision,
    suiteIdentitySha256: input.input.suiteIdentitySha256,
    caseId: manifest.id,
    caseIdentity: structuredClone(input.input.loadedCase.identity),
    runtimeImage: input.input.image,
    runtimeImageDigest: input.runtimeImageDigest,
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: input.runtimeImageDigest,
    expectedSourceCommit: input.input.expectedSourceCommit,
    headlessConfigSha256: sha256Canonical(input.effectiveConfig),
    protocol: input.protocol,
    feedbackVisibility: input.feedbackVisibility,
    trialIndex: input.trialIndex,
    priceSnapshotSha256,
    comparisonIdentity: {
      suiteIdentitySha256: input.input.suiteIdentitySha256,
      caseIdentitySha256: sha256Canonical(input.input.loadedCase.identity),
      runtimeImageDigest: input.runtimeImageDigest,
      caseImageDigest: manifest.caseImage.digest,
      graderImageDigest: input.runtimeImageDigest,
      providerId: provider.id,
      model: provider.model,
      providerType: provider.providerType,
      reasoning: provider.reasoning ?? 'high',
      budget: {
        wallTimeMs: manifest.resources.wallTimeMs,
        cpus: manifest.resources.cpus,
        memoryBytes: manifest.resources.memoryBytes,
        pids: manifest.resources.pids,
        diskBytes: manifest.resources.diskBytes,
        maxAgentSteps: input.effectiveConfig.limits!.maxStepsPerRun!,
        maxContextTokens: input.effectiveConfig.limits!.maxContextTokens!,
      },
      protocol: input.protocol,
      feedbackVisibility: input.feedbackVisibility ?? null,
      trialIndex: input.trialIndex,
      priceSnapshotSha256: priceSnapshotSha256 ?? null,
    },
  }
}

async function resolveRuntimeImageDigest(
  input: RunBenchmarkTrialsInput,
): Promise<string> {
  if (input.runtimeImageDigest) return input.runtimeImageDigest
  if (input.workerRunner) return `test:${sha256Bytes(input.image)}`
  return (await inspectWorkerImage(input.image, input.expectedSourceCommit))
    .digest
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(JSON.stringify(canonicalize(value)))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  )
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonBounded<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath)
  if (raw.byteLength > MAX_RESULT_BYTES)
    throw new Error('artifact is too large')
  return JSON.parse(raw.toString('utf8')) as T
}
