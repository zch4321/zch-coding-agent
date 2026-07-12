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
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import {
  HeadlessResultSchema,
  type HeadlessResult,
} from '../../electron/headless/contracts'
import { compileSchema } from '../../electron/schema-validator'
import { sha256Bytes } from '../cases/hash'
import { prepareBenchmarkWorkspace } from '../cases/prepare'
import { inspectWorkerImage } from '../worker/capabilities'
import { runDockerWorker } from '../worker/coordinator'
import type { DockerWorkerRunInput } from '../worker/contracts'
import type {
  BenchmarkFeedbackVisibility,
  BenchmarkMetricSnapshot,
  BenchmarkTrialIdentity,
  BenchmarkTrialResult,
  BenchmarkTrialsResult,
  NativeEvaluationResult,
  RunBenchmarkTrialsInput,
} from './contracts'
import { createBenchmarkFeedback } from './feedback'
import { collectBenchmarkPatch, evaluateNativePatch } from './native-evaluator'

const MAX_TRIALS = 100
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MAX_LEAK_SCAN_BYTES = 64 * 1024 * 1024
const validateHeadlessResult = compileSchema(HeadlessResultSchema)

interface AttemptCapture {
  patch: string
  evaluation: NativeEvaluationResult
}

interface CompleteMarker {
  schemaVersion: 1
  identitySha256: string
  resultSha256: string
  artifactsSha256: string
}

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
  for (let trialIndex = 1; trialIndex <= trials; trialIndex += 1) {
    if (input.signal?.aborted) throw new Error('Benchmark run was cancelled')
    const identity = createTrialIdentity({
      input,
      protocol,
      feedbackVisibility,
      effectiveConfig,
      runtimeImageDigest,
      trialIndex,
    })
    results.push(
      await runTrial({
        input,
        protocol,
        feedbackVisibility,
        effectiveConfig,
        runtimeImageDigest,
        identity,
      }),
    )
  }
  return { schemaVersion: 1, protocol, trials: results }
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
    return { directory: finalDirectory, result: resumed, reused: true }
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
  await prepareBenchmarkWorkspace({
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
    workspaceDirectory: workspace,
    artifactsDirectory: workerArtifacts,
    config: input.effectiveConfig,
    task: input.input.loadedCase.manifest.task,
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
          workspace,
          directory: path.join(attemptsDirectory, 'initial'),
        })
        if (initial.evaluation.resolved) {
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
      workspace,
      directory: path.join(attemptsDirectory, 'initial'),
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
      workspace,
      directory: path.join(attemptsDirectory, 'after-feedback'),
    })
  }

  const result: BenchmarkTrialResult = {
    schemaVersion: 1,
    identitySha256,
    trialIndex: input.identity.trialIndex,
    protocol: input.protocol,
    workerRunId: worker.runId,
    workerStatus: worker.status,
    sessionId: headless?.sessionId,
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
  let leakScan: Awaited<ReturnType<typeof scanArtifactsForCredential>>
  try {
    leakScan = await scanArtifactsForCredential({
      directory: stagingDirectory,
      credential:
        input.input.credential.mode === 'proxy'
          ? input.input.credential.upstreamCredential
          : input.input.credential.credential,
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
  return { directory: finalDirectory, result, reused: false }
}

async function captureAttempt(input: {
  loadedCase: RunBenchmarkTrialsInput['loadedCase']
  workspace: string
  directory: string
}): Promise<AttemptCapture> {
  await mkdir(input.directory, { recursive: true })
  let patch = ''
  let evaluation: NativeEvaluationResult
  try {
    patch = await collectBenchmarkPatch({
      workspace: input.workspace,
      maxPatchBytes: input.loadedCase.manifest.modificationScope.maxPatchBytes,
    })
    evaluation = await evaluateNativePatch({
      loadedCase: input.loadedCase,
      patch,
    })
  } catch {
    evaluation = {
      schemaVersion: 1,
      status: 'invalid',
      resolved: false,
      patchSha256: sha256Bytes(patch),
      failureCategory: 'patch_invalid',
      publicChecks: [],
      groups: [],
      error: {
        code: 'BENCHMARK_PATCH_INVALID',
        message: 'The evaluator could not grade this patch',
      },
    }
  }
  await Promise.all([
    writeFile(path.join(input.directory, 'patch.diff'), patch, 'utf8'),
    writeJsonAtomic(path.join(input.directory, 'evaluation.json'), evaluation),
  ])
  return { patch, evaluation }
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

async function scanArtifactsForCredential(input: {
  directory: string
  credential: string
}): Promise<{
  schemaVersion: 1
  filesScanned: number
  bytesScanned: number
  sensitiveMatches: 0
}> {
  const needle = Buffer.from(input.credential, 'utf8')
  if (needle.byteLength === 0) throw new Error('Benchmark credential is empty')
  const files = await listFiles(input.directory)
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
    maxStepsPerRun: Math.min(
      config.limits?.maxStepsPerRun ?? resources.maxAgentSteps,
      resources.maxAgentSteps,
    ),
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
  return {
    schemaVersion: 1,
    suiteId: manifest.suite.id,
    suiteRevision: manifest.suite.revision,
    suiteIdentitySha256: input.input.suiteIdentitySha256,
    caseId: manifest.id,
    caseIdentity: structuredClone(input.input.loadedCase.identity),
    runtimeImage: input.input.image,
    runtimeImageDigest: input.runtimeImageDigest,
    expectedSourceCommit: input.input.expectedSourceCommit,
    headlessConfigSha256: sha256Canonical(input.effectiveConfig),
    protocol: input.protocol,
    feedbackVisibility: input.feedbackVisibility,
    trialIndex: input.trialIndex,
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
