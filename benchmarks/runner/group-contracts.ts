import type { HeadlessConfig } from '../../electron/headless/contracts'
import type { LoadedAdapterSuite } from '../adapters/contracts'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import type {
  BenchmarkPriceSnapshot,
  BenchmarkRunGroupSummary,
  BenchmarkTrialMetrics,
} from '../metrics/contracts'
import type {
  BenchmarkEvaluationResult,
  BenchmarkFeedbackVisibility,
  BenchmarkRunnerProtocol,
  BenchmarkTrialsResult,
  DockerWorkerRunner,
} from './contracts'
import type { IsolatedGraderRunner } from '../grader/coordinator'
import type { DockerWorkerCredential } from '../worker/contracts'
import type { BenchmarkCohort } from '../cohort/contracts'

export type BenchmarkRunPreset = 'smoke' | 'daily' | 'full' | 'external'

export const BENCHMARK_PRESETS: Record<
  BenchmarkRunPreset,
  { caseLimit: number | null; trials: number }
> = {
  smoke: { caseLimit: 3, trials: 1 },
  daily: { caseLimit: 8, trials: 3 },
  full: { caseLimit: null, trials: 5 },
  external: { caseLimit: null, trials: 3 },
}

export interface SelectedBenchmarkCase {
  suite: LoadedAdapterSuite
  loadedCase: LoadedBenchmarkCase
}

export interface BenchmarkRunGroupIdentity {
  schemaVersion: 1
  preset: BenchmarkRunPreset
  suites: Array<{
    id: string
    revision: string
    adapterId: string
    adapterRevision: string
    identitySha256: string
  }>
  cases: Array<{
    suiteId: string
    caseId: string
    identitySha256: string
  }>
  image: string
  runtimeImageDigest: string
  sourceCommit: string
  configSha256: string
  provider: {
    id: string
    model: string
    profile: string
    reasoning: string
  }
  protocol: BenchmarkRunnerProtocol
  feedbackVisibility: BenchmarkFeedbackVisibility | null
  trialsPerCase: number
  priceSnapshotSha256: string | null
  cohortHash?: string
}

export interface BenchmarkRunGroupSummaryReport {
  schemaVersion: 1
  identitySha256: string
  preset: BenchmarkRunPreset
  status: 'completed' | 'incomplete'
  cases: number
  trials: number
  resolved: number
  resolvedInitial: number
  recovered: number
  metricsComplete: boolean
  missingMetricTrials: number
  levels: Record<BenchmarkEvaluationResult['level'], number>
  failureCategories: Record<string, number>
  sources?: Partial<
    Record<
      'monthly-swebench' | 'swe-rebench',
      {
        cases: number
        trials: number
        resolved: number
        resolveRate: number
        levels: Record<BenchmarkEvaluationResult['level'], number>
      }
    >
  >
  sourceMacroResolveRate?: number
  efficiency?: BenchmarkRunGroupSummary
  startedAt: string
  completedAt: string
  durationMs: number
}

export interface BenchmarkShareableTrial {
  suiteId: string
  caseId: string
  trialIndex: number
  protocol: BenchmarkRunnerProtocol
  reused: boolean
  resolvedInitial: boolean
  resolvedAfterFeedback: boolean
  recovered: boolean
  evaluation: BenchmarkEvaluationResult
  metrics?: BenchmarkTrialMetrics
  comparisonIdentity: BenchmarkTrialsResult['trials'][number]['identity']['comparisonIdentity']
}

export interface BenchmarkShareableReport {
  schemaVersion: 1
  identitySha256: string
  preset: BenchmarkRunPreset
  summary: BenchmarkRunGroupSummaryReport
  trials: BenchmarkShareableTrial[]
  redaction: {
    policy: 'benchmark-shareable-v1'
    restrictedArtifacts: string[]
    removedFields: string[]
  }
}

export interface BenchmarkRunGroupResult {
  directory: string
  identity: BenchmarkRunGroupIdentity
  identitySha256: string
  summary: BenchmarkRunGroupSummaryReport
  report: BenchmarkShareableReport
  cases: Array<{
    suiteId: string
    caseId: string
    directory: string
    trials: BenchmarkTrialsResult
  }>
}

export type BenchmarkRunProgressEvent =
  | {
      phase: 'case-start'
      caseIndex: number
      caseCount: number
      suiteId: string
      caseId: string
      repository: string
      trialCount: number
    }
  | {
      phase: 'trial-start'
      caseIndex: number
      caseCount: number
      suiteId: string
      caseId: string
      repository: string
      trialIndex: number
      trialCount: number
    }
  | {
      phase: 'trial-complete'
      caseIndex: number
      caseCount: number
      suiteId: string
      caseId: string
      repository: string
      trialIndex: number
      trialCount: number
      reused: boolean
      resolved: boolean
      level: BenchmarkEvaluationResult['level']
      durationMs: number
    }
  | {
      phase: 'case-complete'
      caseIndex: number
      caseCount: number
      suiteId: string
      caseId: string
      repository: string
      trialCount: number
      resolved: number
      durationMs: number
    }

export type BenchmarkCaseTrialRunner =
  typeof import('./runner').runBenchmarkTrials

export interface RunBenchmarkGroupInput {
  preset: BenchmarkRunPreset
  selectedCases: SelectedBenchmarkCase[]
  image: string
  runtimeImageDigest: string
  sourceCommit: string
  config: HeadlessConfig
  credential: DockerWorkerCredential
  outputDirectory: string
  trialsPerCase: number
  protocol: BenchmarkRunnerProtocol
  feedbackVisibility?: BenchmarkFeedbackVisibility
  priceSnapshot?: BenchmarkPriceSnapshot
  cohortHash?: string
  cohort?: BenchmarkCohort
  signal?: AbortSignal
  trialRunner?: BenchmarkCaseTrialRunner
  workerRunner?: DockerWorkerRunner
  graderRunner?: IsolatedGraderRunner
  onProgress?: (event: BenchmarkRunProgressEvent) => void
}
