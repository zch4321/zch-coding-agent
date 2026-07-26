import type {
  BenchmarkComparableTrial,
  BenchmarkComparisonReport,
  BenchmarkPairedDelta,
  BenchmarkRunGroupSummary,
  KnownNumber,
} from './contracts'
import type { BenchmarkTrialsResult } from '../runner/contracts'

/** Reports that benchmark run groups differ in fields required for a valid comparison. */
export class BenchmarkComparisonIdentityError extends Error {
  readonly code = 'BENCHMARK_COMPARISON_IDENTITY_MISMATCH'

  constructor(readonly mismatches: string[]) {
    super(`Benchmark run groups are not comparable: ${mismatches.join(', ')}`)
    this.name = 'BenchmarkComparisonIdentityError'
  }
}

/** Summarizes comparable trials by identity, counts, pass rates, cost, and latency. */
export function summarizeBenchmarkRunGroup(
  trials: readonly BenchmarkComparableTrial[],
): BenchmarkRunGroupSummary {
  const priceSnapshots = new Set(
    trials.map((trial) => trial.identity.priceSnapshotSha256),
  )
  if (priceSnapshots.size > 1) {
    throw new Error('Benchmark run group contains multiple price snapshots')
  }
  const resolvedTrials = trials.filter((trial) => trial.resolved)
  const unresolvedTrials = trials.filter((trial) => !trial.resolved)
  const totalTokens = sumKnown(
    trials.map((trial) => trial.metrics.usage.total.totalTokens),
  )
  const totalCostUsd = sumKnown(
    trials.map((trial) => trial.metrics.cost.totalUsd),
  )
  const totalToolCalls = trials.reduce(
    (total, trial) => total + trial.metrics.tools.attempted,
    0,
  )
  const resolved = resolvedTrials.length
  return {
    schemaVersion: 1,
    trials: trials.length,
    resolved,
    resolveRate: trials.length === 0 ? 0 : resolved / trials.length,
    totalTokens,
    totalCostUsd,
    totalToolCalls,
    tokensPerResolved:
      totalTokens === null || resolved === 0 ? null : totalTokens / resolved,
    costPerResolvedUsd:
      totalCostUsd === null || resolved === 0 ? null : totalCostUsd / resolved,
    toolCallsPerResolved: resolved === 0 ? null : totalToolCalls / resolved,
    medianTimeToResolveMs: median(
      resolvedTrials.map((trial) => trial.metrics.durationMs),
    ),
    unresolvedTokens: sumKnown(
      unresolvedTrials.map((trial) => trial.metrics.usage.total.totalTokens),
    ),
    unresolvedCostUsd: sumKnown(
      unresolvedTrials.map((trial) => trial.metrics.cost.totalUsd),
    ),
  }
}

/** Compares baseline and candidate trial groups and computes per-metric deltas. */
export function compareBenchmarkRunGroups(input: {
  baseline: readonly BenchmarkComparableTrial[]
  candidate: readonly BenchmarkComparableTrial[]
}): BenchmarkComparisonReport {
  const baseline = sortedTrials(input.baseline)
  const candidate = sortedTrials(input.candidate)
  const mismatches = comparisonMismatches(baseline, candidate)
  if (mismatches.length > 0) {
    throw new BenchmarkComparisonIdentityError(mismatches)
  }

  const paired = baseline.map((left, index) =>
    pairedDelta(left, candidate[index]!),
  )
  const deltas = paired.map((pair) => pair.resolveDelta)
  const resolveDelta = mean(deltas)
  return {
    schemaVersion: 1,
    baseline: summarizeBenchmarkRunGroup(baseline),
    candidate: summarizeBenchmarkRunGroup(candidate),
    paired,
    pairedOutcomes: {
      wins: paired.filter((entry) => entry.resolveDelta > 0).length,
      losses: paired.filter((entry) => entry.resolveDelta < 0).length,
      ties: paired.filter((entry) => entry.resolveDelta === 0).length,
    },
    resolveDelta,
    resolveDelta95Ci: confidenceInterval(deltas, resolveDelta),
    ordering: lexicographicOrdering(baseline, candidate),
  }
}

/** Compares the trial groups contained in two benchmark result objects. */
export function compareBenchmarkTrialResults(input: {
  baseline: BenchmarkTrialsResult
  candidate: BenchmarkTrialsResult
}): BenchmarkComparisonReport {
  return compareBenchmarkRunGroups({
    baseline: input.baseline.trials.map(benchmarkTrialToComparable),
    candidate: input.candidate.trials.map(benchmarkTrialToComparable),
  })
}

/** Converts a completed trial into the identity and metrics shape required for comparison. */
export function benchmarkTrialToComparable(
  trial: BenchmarkTrialsResult['trials'][number],
): BenchmarkComparableTrial {
  const metrics = trial.result.metrics
  if (!metrics) {
    throw new Error(
      `Benchmark trial has no comparable metrics: ${trial.identity.caseId}#${trial.identity.trialIndex}`,
    )
  }
  const evaluation =
    trial.result.afterFeedback?.evaluation ?? trial.result.initial.evaluation
  return {
    caseId: trial.identity.caseId,
    identity: trial.identity.comparisonIdentity,
    resolved: evaluation.resolved,
    level: evaluation.level,
    groupMacroScore: evaluation.groupMacroScore,
    hardGatesPassed: evaluation.hardGates.every((gate) => gate.passed),
    metrics,
  }
}

function pairedDelta(
  baseline: BenchmarkComparableTrial,
  candidate: BenchmarkComparableTrial,
): BenchmarkPairedDelta {
  return {
    caseId: baseline.caseId,
    trialIndex: baseline.identity.trialIndex,
    baselineResolved: baseline.resolved,
    candidateResolved: candidate.resolved,
    resolveDelta: (Number(candidate.resolved) - Number(baseline.resolved)) as
      | -1
      | 0
      | 1,
    levelDelta: level(candidate.level) - level(baseline.level),
    groupMacroScoreDelta: candidate.groupMacroScore - baseline.groupMacroScore,
    tokensDelta: differenceKnown(
      candidate.metrics.usage.total.totalTokens,
      baseline.metrics.usage.total.totalTokens,
    ),
    costDeltaUsd: differenceKnown(
      candidate.metrics.cost.totalUsd,
      baseline.metrics.cost.totalUsd,
    ),
    toolCallsDelta:
      candidate.metrics.tools.attempted - baseline.metrics.tools.attempted,
  }
}

function comparisonMismatches(
  baseline: readonly BenchmarkComparableTrial[],
  candidate: readonly BenchmarkComparableTrial[],
): string[] {
  const mismatches: string[] = []
  if (baseline.length !== candidate.length) {
    mismatches.push(`trials (${baseline.length} != ${candidate.length})`)
  }
  for (
    let index = 0;
    index < Math.min(baseline.length, candidate.length);
    index += 1
  ) {
    const left = baseline[index]!
    const right = candidate[index]!
    if (left.caseId !== right.caseId) {
      mismatches.push(
        `trials[${index}].caseId (${left.caseId} != ${right.caseId})`,
      )
    }
    diffValues(
      left.identity,
      right.identity,
      `trials[${index}].identity`,
      mismatches,
    )
  }
  return mismatches
}

function diffValues(
  left: unknown,
  right: unknown,
  path: string,
  output: string[],
): void {
  if (Object.is(left, right)) return
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    output.push(`${path} (${String(left)} != ${String(right)})`)
    return
  }
  const keys = new Set([
    ...Object.keys(left as Record<string, unknown>),
    ...Object.keys(right as Record<string, unknown>),
  ])
  for (const key of [...keys].sort()) {
    diffValues(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      `${path}.${key}`,
      output,
    )
  }
}

function lexicographicOrdering(
  baseline: readonly BenchmarkComparableTrial[],
  candidate: readonly BenchmarkComparableTrial[],
): 'baseline' | 'candidate' | 'tie' {
  const left = rankingVector(baseline)
  const right = rankingVector(candidate)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    return right[index]! > left[index]! ? 'candidate' : 'baseline'
  }
  return 'tie'
}

function rankingVector(trials: readonly BenchmarkComparableTrial[]): number[] {
  const summary = summarizeBenchmarkRunGroup(trials)
  const safety = trials.filter((trial) => trial.hardGatesPassed).length
  const levels = trials.reduce((total, trial) => total + level(trial.level), 0)
  const macro = trials.reduce(
    (total, trial) => total + trial.groupMacroScore,
    0,
  )
  return [
    safety,
    summary.resolved,
    levels,
    macro,
    efficiencyRank(summary.totalCostUsd),
    efficiencyRank(summary.totalTokens),
    -summary.totalToolCalls,
  ]
}

function efficiencyRank(value: KnownNumber): number {
  return value === null ? Number.NEGATIVE_INFINITY : -value
}

function sortedTrials(
  trials: readonly BenchmarkComparableTrial[],
): BenchmarkComparableTrial[] {
  return [...trials].sort(
    (left, right) =>
      left.caseId.localeCompare(right.caseId) ||
      left.identity.trialIndex - right.identity.trialIndex,
  )
}

function level(value: BenchmarkComparableTrial['level']): number {
  return Number(value.slice(1))
}

function sumKnown(values: readonly KnownNumber[]): KnownNumber {
  if (values.some((value) => value === null)) return null
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

function differenceKnown(left: KnownNumber, right: KnownNumber): KnownNumber {
  return left === null || right === null ? null : left - right
}

function median(values: readonly number[]): KnownNumber {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length
}

function confidenceInterval(
  values: readonly number[],
  average: number,
): { low: number; high: number } {
  if (values.length < 2) return { low: average, high: average }
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
    (values.length - 1)
  const margin = 1.96 * Math.sqrt(variance / values.length)
  return {
    low: Math.max(-1, average - margin),
    high: Math.min(1, average + margin),
  }
}
