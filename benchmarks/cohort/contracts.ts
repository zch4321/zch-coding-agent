export const BENCHMARK_COHORT_SCHEMA_VERSION = 1 as const
export const ROLLING_MIXED_COHORT_KIND = 'rolling-mixed-16' as const

export type ExternalBenchmarkSource = 'monthly-swebench' | 'swe-rebench'

export type ExternalCaseClassification = 'bug-fix' | 'non-bug'

export interface ExternalDatasetRelease {
  source: ExternalBenchmarkSource
  dataset: string
  release: string
  commit: string
  adapterRevision: string
}

export interface ExternalBenchmarkCandidate {
  source: ExternalBenchmarkSource
  dataset: string
  release: string
  commit: string
  adapterRevision: string
  caseId: string
  repository: string
  classification: ExternalCaseClassification
  language: string
  problemStatement: string
  baseCommit: string
  patchBytes: number
  officialImageReference: string
  officialImageDigest?: string
  privatePayload: MonthlyPrivatePayload | SweRebenchPrivatePayload
}

export interface MonthlyPrivatePayload {
  kind: 'monthly-swebench'
  archiveFile: 'bugfix.tar.zst' | 'non_bugfix.tar.zst'
  instructionPath: string
  taskPath: string
  environmentPath: string
  solutionPath: string
  testsPath: string
}

export interface SweRebenchPrivatePayload {
  kind: 'swe-rebench'
  solutionPatch: string
  testPatch: string
  failToPass: string[]
  passToPass: string[]
  verifier: Record<string, unknown>
}

export interface BenchmarkCohortCase {
  source: ExternalBenchmarkSource
  dataset: string
  release: string
  commit: string
  adapterRevision: string
  caseId: string
  repository: string
  classification: ExternalCaseClassification
  language: string
  patchScale: 'small' | 'medium' | 'large'
  caseHash: string
  officialImage: {
    reference: string
    digest: string
  }
  agentImageDigest: string
}

export interface BenchmarkCohortExclusion {
  source: ExternalBenchmarkSource
  caseId: string
  reason:
    | 'invalid_fields'
    | 'duplicate_repository'
    | 'image_unavailable'
    | 'resource_limit'
    | 'compatibility_failed'
}

export interface BenchmarkCohort {
  schemaVersion: typeof BENCHMARK_COHORT_SCHEMA_VERSION
  kind: typeof ROLLING_MIXED_COHORT_KIND
  createdAt: string
  seed: string
  sources: ExternalDatasetRelease[]
  cases: BenchmarkCohortCase[]
  exclusions: BenchmarkCohortExclusion[]
  cohortHash: string
}

export interface ResolvedExternalImage {
  eligible: boolean
  reason?: Extract<
    BenchmarkCohortExclusion['reason'],
    'image_unavailable' | 'resource_limit' | 'compatibility_failed'
  >
  officialReference?: string
  officialDigest?: string
  agentImageDigest?: string
}
