import type {
  HeadlessConfig,
  HeadlessResult,
} from '../../electron/headless/contracts'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import type { BenchmarkCaseAdapter } from '../adapters/contracts'
import type {
  BenchmarkComparisonIdentity,
  BenchmarkPriceSnapshot,
  BenchmarkTrialMetrics,
} from '../metrics/contracts'
import type { IsolatedGraderRunner } from '../grader/coordinator'
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

export interface BenchmarkHardGate {
  id:
    | 'patch_applies'
    | 'modification_scope'
    | 'patch_hygiene'
    | 'agent_execution_boundary'
    | 'agent_result_valid'
    | 'runtime_identity'
    | 'worker_cleanup'
    | 'credential_clean'
    | 'grader_sandbox'
    | 'grader_input_immutable'
    | 'grader_completed'
    | 'grader_cleanup'
  passed: boolean
  owner: 'agent' | 'infrastructure'
}

export interface BenchmarkEvaluationResult {
  schemaVersion: 2
  status: 'unsupported' | 'invalid' | 'attempted' | 'graded'
  resolved: boolean
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
  groupMacroScore: number
  patchSha256: string
  failureCategory:
    | 'none'
    | 'unsupported'
    | 'no_change'
    | 'patch_invalid'
    | 'scope_violation'
    | 'patch_hygiene_failed'
    | 'setup_failed'
    | 'regression_failed'
    | 'acceptance_failed'
    | 'hard_gate_failed'
    | 'infrastructure_failed'
  hardGates: BenchmarkHardGate[]
  publicChecks: BenchmarkCheckOutcome[]
  groups: Array<
    BenchmarkGroupOutcome & {
      weight: number
      evidence: {
        public: {
          passed: number
          total: number
          failureCategories: string[]
        }
        private: {
          passed: number
          total: number
          failureCategories: string[]
        }
      }
    }
  >
  grader: { revision: string; imageDigest: string; inputSha256: string }
  error?: { code: string; message: string }
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
  graderRevision: string
  graderImageDigest: string
  expectedSourceCommit?: string
  headlessConfigSha256: string
  protocol: BenchmarkRunnerProtocol
  feedbackVisibility?: BenchmarkFeedbackVisibility
  trialIndex: number
  priceSnapshotSha256?: string
  comparisonIdentity: BenchmarkComparisonIdentity
}

export interface BenchmarkTrialResult {
  schemaVersion: typeof BENCHMARK_RUNNER_SCHEMA_VERSION
  identitySha256: string
  trialIndex: number
  protocol: BenchmarkRunnerProtocol
  workerRunId: string
  workerStatus: DockerWorkerResult['status']
  sessionId?: string
  metrics?: BenchmarkTrialMetrics
  artifacts?: {
    conversationMarkdown?: string
    sessionTranscript?: string
  }
  initial: {
    evaluation: BenchmarkEvaluationResult
    metrics?: BenchmarkMetricSnapshot
  }
  afterFeedback?: {
    evaluation: BenchmarkEvaluationResult
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
    identity: BenchmarkTrialIdentity
    result: BenchmarkTrialResult
    reused: boolean
  }>
}

export type DockerWorkerRunner = (
  input: DockerWorkerRunInput,
) => Promise<DockerWorkerResult>

export interface RunBenchmarkTrialsInput {
  loadedCase: LoadedBenchmarkCase
  adapter: BenchmarkCaseAdapter
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
  graderRunner?: IsolatedGraderRunner
  priceSnapshot?: BenchmarkPriceSnapshot
}
