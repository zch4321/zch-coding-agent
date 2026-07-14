import type { LlmUsageRecord } from '../../shared/usage'

export const BENCHMARK_METRICS_SCHEMA_VERSION = 1 as const

export type BenchmarkUsageScope = LlmUsageRecord['scope']
export type KnownNumber = number | null

export interface BenchmarkUsageMetrics {
  records: number
  missingRecords: number
  promptTokens: KnownNumber
  completionTokens: KnownNumber
  reasoningTokens: KnownNumber
  totalTokens: KnownNumber
  cacheHitTokens: KnownNumber
  cacheMissTokens: KnownNumber
}

export interface BenchmarkToolBucket {
  attempted: number
  proposed: number
  executed: number
  succeeded: number
  failed: number
  denied: number
  cancelled: number
  timedOut: number
  durationMs: number
  inputBytes: number
  outputBytes: number
  truncated: number
}

export interface BenchmarkToolMetrics extends BenchmarkToolBucket {
  duplicateArgumentSignatures: number
  byTool: Record<string, BenchmarkToolBucket>
  byEffect: Record<string, BenchmarkToolBucket>
  firstEffectiveEditMs: KnownNumber
  firstTestMs: KnownNumber
  idleAfterFinalVerificationMs: KnownNumber
}

export interface BenchmarkPatchMetrics {
  changedFiles: number
  addedLines: number
  deletedLines: number
  testFilesChanged: number
  binaryFilesChanged: number
  workspaceOutsideWriteAttempts: number
}

export interface BenchmarkTrajectoryMetrics {
  llmRequests: number
  continuations: number
  compactions: number
  planUpdates: number
  goalUpdates: number
  mcpDisclosures: number
  mcpCalls: number
  approvalRequests: number
  promptBuilds: number
  terminalEvents: number
}

export interface BenchmarkPriceSnapshot {
  schemaVersion: 1
  id: string
  source: string
  revision: string
  currency: 'USD'
  providerId: string
  model: string
  ratesPerMillionTokens: Partial<
    Record<
      | 'promptTokens'
      | 'completionTokens'
      | 'reasoningTokens'
      | 'cacheHitTokens'
      | 'cacheMissTokens',
      number
    >
  >
}

export interface BenchmarkCostMetrics {
  currency: 'USD'
  priceSnapshotId: string | null
  totalUsd: KnownNumber
  byScope: Record<BenchmarkUsageScope, KnownNumber>
}

export interface BenchmarkTrialMetrics {
  schemaVersion: typeof BENCHMARK_METRICS_SCHEMA_VERSION
  usage: {
    byScope: Record<BenchmarkUsageScope, BenchmarkUsageMetrics>
    total: BenchmarkUsageMetrics
  }
  tools: BenchmarkToolMetrics
  patch: BenchmarkPatchMetrics
  trajectory: BenchmarkTrajectoryMetrics
  cost: BenchmarkCostMetrics
  durationMs: number
}

export interface BenchmarkRunGroupSummary {
  schemaVersion: typeof BENCHMARK_METRICS_SCHEMA_VERSION
  trials: number
  resolved: number
  resolveRate: number
  totalTokens: KnownNumber
  totalCostUsd: KnownNumber
  totalToolCalls: number
  tokensPerResolved: KnownNumber
  costPerResolvedUsd: KnownNumber
  toolCallsPerResolved: KnownNumber
  medianTimeToResolveMs: KnownNumber
  unresolvedTokens: KnownNumber
  unresolvedCostUsd: KnownNumber
}

export interface BenchmarkComparisonIdentity {
  suiteIdentitySha256: string
  caseIdentitySha256: string
  runtimeImageDigest: string
  caseImageDigest: string
  graderImageDigest: string
  providerId: string
  model: string
  profile: string
  reasoning: string
  budget: {
    wallTimeMs: number
    cpus: number
    memoryBytes: number
    pids: number
    diskBytes: number
    maxAgentSteps: number
    maxContextTokens: number
  }
  protocol: string
  feedbackVisibility: string | null
  trialIndex: number
  priceSnapshotSha256: string | null
}

export interface BenchmarkComparableTrial {
  caseId: string
  identity: BenchmarkComparisonIdentity
  resolved: boolean
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
  groupMacroScore: number
  hardGatesPassed: boolean
  metrics: BenchmarkTrialMetrics
}

export interface BenchmarkPairedDelta {
  caseId: string
  trialIndex: number
  baselineResolved: boolean
  candidateResolved: boolean
  resolveDelta: -1 | 0 | 1
  levelDelta: number
  groupMacroScoreDelta: number
  tokensDelta: KnownNumber
  costDeltaUsd: KnownNumber
  toolCallsDelta: number
}

export interface BenchmarkComparisonReport {
  schemaVersion: typeof BENCHMARK_METRICS_SCHEMA_VERSION
  baseline: BenchmarkRunGroupSummary
  candidate: BenchmarkRunGroupSummary
  paired: BenchmarkPairedDelta[]
  pairedOutcomes: { wins: number; losses: number; ties: number }
  resolveDelta: number
  resolveDelta95Ci: { low: number; high: number }
  ordering: 'baseline' | 'candidate' | 'tie'
}
