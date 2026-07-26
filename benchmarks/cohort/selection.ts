import { randomBytes } from 'node:crypto'
import type {
  BenchmarkCohort,
  BenchmarkCohortCase,
  BenchmarkCohortExclusion,
  ExternalBenchmarkCandidate,
  ExternalBenchmarkSource,
  ExternalDatasetRelease,
  ResolvedExternalImage,
} from './contracts'
import {
  BENCHMARK_COHORT_SCHEMA_VERSION,
  ROLLING_MIXED_COHORT_KIND,
} from './contracts'
import { sha256Canonical } from './hash'

const SOURCE_QUOTA = 8

export interface BuildRollingMixedCohortInput {
  releases: ExternalDatasetRelease[]
  candidates: ExternalBenchmarkCandidate[]
  seed?: string
  now?: () => Date
  initialExclusions?: BenchmarkCohortExclusion[]
  resolveImage: (
    candidate: ExternalBenchmarkCandidate,
  ) => Promise<ResolvedExternalImage>
}

/** Builds rolling mixed cohort. */
export async function buildRollingMixedCohort(
  input: BuildRollingMixedCohortInput,
): Promise<BenchmarkCohort> {
  const seed = input.seed?.trim() || randomBytes(16).toString('hex')
  const exclusions: BenchmarkCohortExclusion[] = [
    ...(input.initialExclusions ?? []),
  ]
  const selected: BenchmarkCohortCase[] = []
  const repositories = new Set<string>()

  await selectMonthly(input, seed, selected, exclusions, repositories)
  await selectRebench(input, seed, selected, exclusions, repositories)

  const monthlyCount = countSource(selected, 'monthly-swebench')
  const rebenchCount = countSource(selected, 'swe-rebench')
  if (monthlyCount !== SOURCE_QUOTA || rebenchCount !== SOURCE_QUOTA) {
    throw new Error(
      `Unable to construct rolling mixed cohort: monthly=${monthlyCount}, rebench=${rebenchCount}`,
    )
  }

  const draft = {
    schemaVersion: BENCHMARK_COHORT_SCHEMA_VERSION,
    kind: ROLLING_MIXED_COHORT_KIND,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    seed,
    sources: [...input.releases].sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
    cases: selected,
    exclusions,
  }
  return { ...draft, cohortHash: sha256Canonical(draft) }
}

async function selectMonthly(
  input: BuildRollingMixedCohortInput,
  seed: string,
  selected: BenchmarkCohortCase[],
  exclusions: BenchmarkCohortExclusion[],
  repositories: Set<string>,
): Promise<void> {
  for (const classification of ['bug-fix', 'non-bug'] as const) {
    const ordered = deterministicOrder(
      input.candidates.filter(
        (candidate) =>
          candidate.source === 'monthly-swebench' &&
          candidate.classification === classification,
      ),
      `${seed}:monthly:${classification}`,
    )
    await takeEligible({
      input,
      ordered,
      quota: 4,
      selected,
      exclusions,
      repositories,
    })
  }
}

async function selectRebench(
  input: BuildRollingMixedCohortInput,
  seed: string,
  selected: BenchmarkCohortCase[],
  exclusions: BenchmarkCohortExclusion[],
  repositories: Set<string>,
): Promise<void> {
  const candidates = input.candidates.filter(
    (candidate) => candidate.source === 'swe-rebench',
  )
  const buckets = (['small', 'medium', 'large'] as const).map((scale) =>
    deterministicOrder(
      candidates.filter(
        (candidate) => patchScale(candidate.patchBytes) === scale,
      ),
      `${seed}:rebench:${scale}`,
    ),
  )
  const roundRobin: ExternalBenchmarkCandidate[] = []
  for (
    let index = 0;
    buckets.some((bucket) => index < bucket.length);
    index += 1
  ) {
    for (const bucket of buckets) {
      const candidate = bucket[index]
      if (candidate) roundRobin.push(candidate)
    }
  }
  await takeEligible({
    input,
    ordered: roundRobin,
    quota: SOURCE_QUOTA,
    selected,
    exclusions,
    repositories,
  })
}

async function takeEligible(input: {
  input: BuildRollingMixedCohortInput
  ordered: ExternalBenchmarkCandidate[]
  quota: number
  selected: BenchmarkCohortCase[]
  exclusions: BenchmarkCohortExclusion[]
  repositories: Set<string>
}): Promise<void> {
  let accepted = 0
  for (const candidate of input.ordered) {
    if (accepted >= input.quota) return
    if (input.repositories.has(candidate.repository)) {
      input.exclusions.push(exclusion(candidate, 'duplicate_repository'))
      continue
    }
    const image = await input.input.resolveImage(candidate)
    if (
      !image.eligible ||
      !image.officialReference ||
      !isDigest(image.officialDigest) ||
      !isDigest(image.agentImageDigest)
    ) {
      input.exclusions.push(
        exclusion(candidate, image.reason ?? 'image_unavailable'),
      )
      continue
    }
    input.selected.push({
      source: candidate.source,
      dataset: candidate.dataset,
      release: candidate.release,
      commit: candidate.commit,
      adapterRevision: candidate.adapterRevision,
      caseId: candidate.caseId,
      repository: candidate.repository,
      classification: candidate.classification,
      language: candidate.language,
      patchScale: patchScale(candidate.patchBytes),
      caseHash: candidateHash(candidate),
      officialImage: {
        reference: image.officialReference,
        digest: image.officialDigest,
      },
      agentImageDigest: image.agentImageDigest,
    })
    input.repositories.add(candidate.repository)
    accepted += 1
  }
}

/** Returns or updates candidate hash state. */
export function candidateHash(candidate: ExternalBenchmarkCandidate): string {
  return sha256Canonical(candidate)
}

/** Returns or updates patch scale state. */
export function patchScale(bytes: number): 'small' | 'medium' | 'large' {
  if (bytes <= 2_048) return 'small'
  if (bytes <= 12_288) return 'medium'
  return 'large'
}

/** Returns or updates verify cohort state. */
export function verifyCohort(cohort: BenchmarkCohort): void {
  const { cohortHash, ...draft } = cohort
  if (sha256Canonical(draft) !== cohortHash) {
    throw new Error('Benchmark cohort checksum mismatch')
  }
  if (
    countSource(cohort.cases, 'monthly-swebench') !== SOURCE_QUOTA ||
    countSource(cohort.cases, 'swe-rebench') !== SOURCE_QUOTA
  ) {
    throw new Error('Benchmark cohort must contain exactly 8+8 cases')
  }
  const repositories = cohort.cases.map((entry) => entry.repository)
  if (new Set(repositories).size !== repositories.length) {
    throw new Error('Benchmark cohort contains duplicate repositories')
  }
}

/** Validates same cohort and throws when it is invalid. */
export function assertSameCohort(
  left: BenchmarkCohort,
  right: BenchmarkCohort,
): void {
  verifyCohort(left)
  verifyCohort(right)
  if (left.cohortHash !== right.cohortHash) {
    throw new Error('Benchmark A/B runs must use the same cohort hash')
  }
}

function deterministicOrder(
  candidates: ExternalBenchmarkCandidate[],
  seed: string,
): ExternalBenchmarkCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftScore = sha256Canonical([seed, left.caseId])
    const rightScore = sha256Canonical([seed, right.caseId])
    return (
      leftScore.localeCompare(rightScore) ||
      left.caseId.localeCompare(right.caseId)
    )
  })
}

function exclusion(
  candidate: ExternalBenchmarkCandidate,
  reason: BenchmarkCohortExclusion['reason'],
): BenchmarkCohortExclusion {
  return { source: candidate.source, caseId: candidate.caseId, reason }
}

function countSource(
  cases: BenchmarkCohortCase[],
  source: ExternalBenchmarkSource,
): number {
  return cases.filter((entry) => entry.source === source).length
}

function isDigest(value: string | undefined): value is string {
  return /^sha256:[a-f0-9]{64}$/u.test(value ?? '')
}
