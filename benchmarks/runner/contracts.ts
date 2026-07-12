import type {
  HeadlessConfig,
  HeadlessResult,
} from '../../electron/headless/contracts'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import type {
  DockerWorkerCredential,
  DockerWorkerResult,
  DockerWorkerRunInput,
} from '../worker/contracts'

export const BENCHMARK_RUNNER_SCHEMA_VERSION = 1 as const

export type BenchmarkRunnerProtocol = 'strict' | 'repair-once'
export type BenchmarkFeedbackVisibility = 'public' | 'diagnostic'

export interface BenchmarkCheckOutcome {
  id: string
  title: string
  acceptanceGroupId: string
  passed: boolean
}

export interface BenchmarkGroupOutcome {
  id: string
  title: string
  critical: boolean
  passed: boolean
  publicPassed: boolean
  privatePassed: boolean
}

export interface NativeEvaluationResult {
  schemaVersion: typeof BENCHMARK_RUNNER_SCHEMA_VERSION
  status: 'graded' | 'invalid'
  resolved: boolean
  patchSha256: string
  failureCategory:
    | 'none'
    | 'patch_invalid'
    | 'setup_failed'
    | 'public_check_failed'
    | 'acceptance_failed'
    | 'grader_failed'
  publicChecks: BenchmarkCheckOutcome[]
  groups: BenchmarkGroupOutcome[]
  error?: { code: string; message: string }
}

export interface BenchmarkMetricSnapshot {
  usage: HeadlessResult['usage']
  tools: HeadlessResult['tools']
}

export interface BenchmarkTrialIdentity {
  schemaVersion: typeof BENCHMARK_RUNNER_SCHEMA_VERSION
  suiteId: string
  suiteRevision: string
  suiteIdentitySha256: string
  caseId: string
  caseIdentity: LoadedBenchmarkCase['identity']
  runtimeImage: string
  runtimeImageDigest: string
  expectedSourceCommit?: string
  headlessConfigSha256: string
  protocol: BenchmarkRunnerProtocol
  feedbackVisibility?: BenchmarkFeedbackVisibility
  trialIndex: number
}

export interface BenchmarkTrialResult {
  schemaVersion: typeof BENCHMARK_RUNNER_SCHEMA_VERSION
  identitySha256: string
  trialIndex: number
  protocol: BenchmarkRunnerProtocol
  workerRunId: string
  workerStatus: DockerWorkerResult['status']
  sessionId?: string
  initial: {
    evaluation: NativeEvaluationResult
    metrics?: BenchmarkMetricSnapshot
  }
  afterFeedback?: {
    evaluation: NativeEvaluationResult
    incrementalMetrics?: BenchmarkMetricSnapshot
    cumulativeMetrics?: BenchmarkMetricSnapshot
  }
  repairAttempted: boolean
  resolvedInitial: boolean
  resolvedAfterFeedback: boolean
  recovered: boolean
  completedAt: string
}

export interface BenchmarkTrialsResult {
  schemaVersion: typeof BENCHMARK_RUNNER_SCHEMA_VERSION
  protocol: BenchmarkRunnerProtocol
  trials: Array<{
    directory: string
    result: BenchmarkTrialResult
    reused: boolean
  }>
}

export type DockerWorkerRunner = (
  input: DockerWorkerRunInput,
) => Promise<DockerWorkerResult>

export interface RunBenchmarkTrialsInput {
  loadedCase: LoadedBenchmarkCase
  suiteIdentitySha256: string
  image: string
  runtimeImageDigest?: string
  expectedSourceCommit?: string
  config: HeadlessConfig
  credential: DockerWorkerCredential
  outputDirectory: string
  trials?: number
  protocol?: BenchmarkRunnerProtocol
  feedbackVisibility?: BenchmarkFeedbackVisibility
  signal?: AbortSignal
  workerRunner?: DockerWorkerRunner
}
