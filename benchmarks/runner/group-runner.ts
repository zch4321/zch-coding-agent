import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import { sha256Bytes } from '../cases/hash'
import { verifyCohort } from '../cohort/selection'
import { summarizeBenchmarkRunGroup } from '../metrics/compare'
import { runBenchmarkTrials } from './runner'
import type {
  BenchmarkRunGroupIdentity,
  BenchmarkRunGroupResult,
  BenchmarkRunGroupSummaryReport,
  BenchmarkShareableReport,
  BenchmarkShareableTrial,
  RunBenchmarkGroupInput,
} from './group-contracts'

const GROUP_IDENTITY_FILE = 'run-group-identity.json'
const GROUP_STATE_FILE = 'run-group.json'

interface RunGroupState {
  schemaVersion: 1
  identitySha256: string
  status: 'running' | 'completed' | 'incomplete'
  startedAt: string
  completedAt?: string
}

export async function runBenchmarkGroup(
  input: RunBenchmarkGroupInput,
): Promise<BenchmarkRunGroupResult> {
  validateInput(input)
  const outputDirectory = path.resolve(input.outputDirectory)
  const identity = createRunGroupIdentity(input)
  const identitySha256 = sha256Canonical(identity)
  const startedAt = await prepareRunGroupDirectory({
    outputDirectory,
    identity,
    identitySha256,
    config: input.config,
    priceSnapshot: input.priceSnapshot,
    cohort: input.cohort,
  })
  const cases: BenchmarkRunGroupResult['cases'] = []
  const trialRunner = input.trialRunner ?? runBenchmarkTrials

  try {
    for (const selected of input.selectedCases) {
      if (input.signal?.aborted) throw new Error('Benchmark run was cancelled')
      const manifest = selected.loadedCase.manifest
      const caseDirectory = path.join(
        outputDirectory,
        'cases',
        manifest.suite.id,
        manifest.id,
      )
      const trialsDirectory = path.join(caseDirectory, 'trials')
      await mkdir(trialsDirectory, { recursive: true })
      await Promise.all([
        writeJsonAtomic(
          path.join(caseDirectory, 'manifest.snapshot.json'),
          manifest,
        ),
        writeJsonAtomic(
          path.join(caseDirectory, 'agent-case.json'),
          selected.suite.caseAdapter.toAgentCaseDescriptor(selected.loadedCase),
        ),
        writeFile(path.join(caseDirectory, 'task.txt'), manifest.task, 'utf8'),
      ])
      const trials = await trialRunner({
        loadedCase: selected.loadedCase,
        adapter: selected.suite.caseAdapter,
        suiteIdentitySha256: selected.suite.suiteIdentitySha256,
        ...selected.suite.caseAdapter.executionImage({
          loadedCase: selected.loadedCase,
          defaultImage: input.image,
          defaultImageDigest: input.runtimeImageDigest,
        }),
        proxyImage: input.image,
        expectedSourceCommit: input.sourceCommit,
        config: input.config,
        credential: input.credential,
        outputDirectory: trialsDirectory,
        trials: input.trialsPerCase,
        protocol: input.protocol,
        feedbackVisibility: input.feedbackVisibility,
        signal: input.signal,
        workerRunner: input.workerRunner,
        graderRunner: input.graderRunner,
        priceSnapshot: input.priceSnapshot,
      })
      const record = {
        suiteId: manifest.suite.id,
        caseId: manifest.id,
        directory: caseDirectory,
        trials,
      }
      cases.push(record)
      await writeJsonAtomic(
        path.join(caseDirectory, 'case-result.restricted.json'),
        record,
      )
    }

    const completedAt = new Date().toISOString()
    const reportTrials = shareableTrials(cases)
    const summary = summarizeRunGroup({
      identitySha256,
      preset: input.preset,
      trials: reportTrials,
      startedAt,
      completedAt,
    })
    const report = shareableReport(
      identitySha256,
      input.preset,
      summary,
      reportTrials,
    )
    await Promise.all([
      writeJsonAtomic(path.join(outputDirectory, 'summary.json'), summary),
      writeJsonAtomic(
        path.join(outputDirectory, 'shareable-report.json'),
        report,
      ),
      writeJsonAtomic(
        path.join(outputDirectory, 'redaction.json'),
        report.redaction,
      ),
    ])
    const complete = {
      schemaVersion: 1,
      identitySha256,
      summarySha256: sha256Bytes(
        await readFile(path.join(outputDirectory, 'summary.json')),
      ),
      reportSha256: sha256Bytes(
        await readFile(path.join(outputDirectory, 'shareable-report.json')),
      ),
      completedAt,
    }
    await writeJsonAtomic(path.join(outputDirectory, 'complete.json'), complete)
    await writeState(outputDirectory, {
      schemaVersion: 1,
      identitySha256,
      status: summary.status,
      startedAt,
      completedAt,
    })
    return {
      directory: outputDirectory,
      identity,
      identitySha256,
      summary,
      report,
      cases,
    }
  } catch (error) {
    await writeState(outputDirectory, {
      schemaVersion: 1,
      identitySha256,
      status: 'incomplete',
      startedAt,
      completedAt: new Date().toISOString(),
    }).catch(() => undefined)
    throw error
  }
}

function createRunGroupIdentity(
  input: RunBenchmarkGroupInput,
): BenchmarkRunGroupIdentity {
  const suites = new Map<string, BenchmarkRunGroupIdentity['suites'][number]>()
  for (const selected of input.selectedCases) {
    const suite = selected.suite
    suites.set(suite.suite.id, {
      id: suite.suite.id,
      revision: suite.suite.revision,
      adapterId: suite.adapter.id,
      adapterRevision: suite.adapter.revision,
      identitySha256: suite.suiteIdentitySha256,
    })
  }
  const priceSnapshotSha256 = input.priceSnapshot
    ? sha256Canonical(input.priceSnapshot)
    : null
  return {
    schemaVersion: 1,
    preset: input.preset,
    suites: [...suites.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    cases: input.selectedCases
      .map(({ suite, loadedCase }) => ({
        suiteId: suite.suite.id,
        caseId: loadedCase.manifest.id,
        identitySha256: sha256Canonical(loadedCase.identity),
      }))
      .sort(
        (left, right) =>
          left.suiteId.localeCompare(right.suiteId) ||
          left.caseId.localeCompare(right.caseId),
      ),
    image: input.image,
    runtimeImageDigest: input.runtimeImageDigest,
    sourceCommit: input.sourceCommit,
    configSha256: sha256Canonical(input.config),
    provider: {
      id: input.config.provider.id,
      model: input.config.provider.model,
      profile: input.config.provider.profile ?? 'generic',
      reasoning: input.config.provider.reasoning ?? 'high',
    },
    protocol: input.protocol,
    feedbackVisibility: input.feedbackVisibility ?? null,
    trialsPerCase: input.trialsPerCase,
    priceSnapshotSha256,
    ...(input.cohortHash ? { cohortHash: input.cohortHash } : {}),
  }
}

async function prepareRunGroupDirectory(input: {
  outputDirectory: string
  identity: BenchmarkRunGroupIdentity
  identitySha256: string
  config: RunBenchmarkGroupInput['config']
  priceSnapshot?: RunBenchmarkGroupInput['priceSnapshot']
  cohort?: RunBenchmarkGroupInput['cohort']
}): Promise<string> {
  await mkdir(input.outputDirectory, { recursive: true })
  const entries = await readdir(input.outputDirectory)
  const identityPath = path.join(input.outputDirectory, GROUP_IDENTITY_FILE)
  let startedAt = new Date().toISOString()
  if (entries.length > 0) {
    let existing: BenchmarkRunGroupIdentity
    try {
      existing = JSON.parse(
        await readFile(identityPath, 'utf8'),
      ) as BenchmarkRunGroupIdentity
    } catch {
      throw new Error(
        'Benchmark output directory is non-empty and has no valid identity',
      )
    }
    if (sha256Canonical(existing) !== input.identitySha256) {
      throw new Error('Benchmark run-group identity mismatch')
    }
    let existingConfig: unknown
    try {
      existingConfig = JSON.parse(
        await readFile(
          path.join(input.outputDirectory, 'config.snapshot.json'),
          'utf8',
        ),
      )
    } catch {
      throw new Error('Benchmark config snapshot is missing or invalid')
    }
    if (sha256Canonical(existingConfig) !== input.identity.configSha256) {
      throw new Error('Benchmark config snapshot checksum mismatch')
    }
    if (input.identity.priceSnapshotSha256) {
      let existingPrice: unknown
      try {
        existingPrice = JSON.parse(
          await readFile(
            path.join(input.outputDirectory, 'price-snapshot.json'),
            'utf8',
          ),
        )
      } catch {
        throw new Error('Benchmark price snapshot is missing or invalid')
      }
      if (
        sha256Canonical(existingPrice) !== input.identity.priceSnapshotSha256
      ) {
        throw new Error('Benchmark price snapshot checksum mismatch')
      }
    }
    if (input.identity.cohortHash) {
      let existingCohort: unknown
      try {
        existingCohort = JSON.parse(
          await readFile(
            path.join(input.outputDirectory, 'cohort.json'),
            'utf8',
          ),
        )
      } catch {
        throw new Error('Benchmark cohort is missing or invalid')
      }
      try {
        verifyCohort(
          existingCohort as NonNullable<RunBenchmarkGroupInput['cohort']>,
        )
      } catch {
        throw new Error('Benchmark cohort checksum mismatch')
      }
      if (
        (existingCohort as NonNullable<RunBenchmarkGroupInput['cohort']>)
          .cohortHash !== input.identity.cohortHash
      ) {
        throw new Error('Benchmark cohort checksum mismatch')
      }
    }
    try {
      const state = JSON.parse(
        await readFile(
          path.join(input.outputDirectory, GROUP_STATE_FILE),
          'utf8',
        ),
      ) as RunGroupState
      if (
        state.identitySha256 === input.identitySha256 &&
        Number.isFinite(Date.parse(state.startedAt))
      ) {
        startedAt = state.startedAt
      }
    } catch {
      // The immutable identity is sufficient to resume individual trials.
    }
  } else {
    await Promise.all([
      writeJsonAtomic(identityPath, input.identity),
      writeJsonAtomic(
        path.join(input.outputDirectory, 'config.snapshot.json'),
        input.config,
      ),
      ...(input.priceSnapshot
        ? [
            writeJsonAtomic(
              path.join(input.outputDirectory, 'price-snapshot.json'),
              input.priceSnapshot,
            ),
          ]
        : []),
      ...(input.cohort
        ? [
            writeJsonAtomic(
              path.join(input.outputDirectory, 'cohort.json'),
              input.cohort,
            ),
          ]
        : []),
    ])
  }
  await writeState(input.outputDirectory, {
    schemaVersion: 1,
    identitySha256: input.identitySha256,
    status: 'running',
    startedAt,
  })
  return startedAt
}

function shareableTrials(
  cases: BenchmarkRunGroupResult['cases'],
): BenchmarkShareableTrial[] {
  return cases.flatMap((entry) =>
    entry.trials.trials.map((trial) => {
      const evaluation =
        trial.result.afterFeedback?.evaluation ??
        trial.result.initial.evaluation
      return {
        suiteId: entry.suiteId,
        caseId: entry.caseId,
        trialIndex: trial.result.trialIndex,
        protocol: trial.result.protocol,
        reused: trial.reused,
        resolvedInitial: trial.result.resolvedInitial,
        resolvedAfterFeedback: trial.result.resolvedAfterFeedback,
        recovered: trial.result.recovered,
        evaluation: publicEvaluation(evaluation),
        metrics: trial.result.metrics,
        comparisonIdentity: trial.identity.comparisonIdentity,
      }
    }),
  )
}

function publicEvaluation(
  evaluation: BenchmarkShareableTrial['evaluation'],
): BenchmarkShareableTrial['evaluation'] {
  const shareable = structuredClone(evaluation)
  delete shareable.error
  return shareable
}

function summarizeRunGroup(input: {
  identitySha256: string
  preset: RunBenchmarkGroupInput['preset']
  trials: BenchmarkShareableTrial[]
  startedAt: string
  completedAt: string
}): BenchmarkRunGroupSummaryReport {
  const missingMetricTrials = input.trials.filter(
    (trial) => !trial.metrics,
  ).length
  const levels = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 }
  const failureCategories: Record<string, number> = {}
  for (const trial of input.trials) {
    levels[trial.evaluation.level] += 1
    failureCategories[trial.evaluation.failureCategory] =
      (failureCategories[trial.evaluation.failureCategory] ?? 0) + 1
  }
  const metricsComplete = missingMetricTrials === 0
  const comparable = metricsComplete
    ? input.trials.map((trial) => ({
        caseId: trial.caseId,
        identity: trial.comparisonIdentity,
        resolved: trial.evaluation.resolved,
        level: trial.evaluation.level,
        groupMacroScore: trial.evaluation.groupMacroScore,
        hardGatesPassed: trial.evaluation.hardGates.every(
          (gate) => gate.passed,
        ),
        metrics: trial.metrics!,
      }))
    : []
  const sourceGroups = Object.fromEntries(
    (['monthly-swebench', 'swe-rebench'] as const)
      .map((source) => {
        const trials = input.trials.filter((trial) =>
          trial.suiteId.startsWith(`${source}-`),
        )
        if (trials.length === 0) return undefined
        const sourceLevels = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 }
        for (const trial of trials) sourceLevels[trial.evaluation.level] += 1
        const resolved = trials.filter(
          (trial) => trial.evaluation.resolved,
        ).length
        return [
          source,
          {
            cases: new Set(trials.map((trial) => trial.caseId)).size,
            trials: trials.length,
            resolved,
            resolveRate: resolved / trials.length,
            levels: sourceLevels,
          },
        ] as const
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  )
  const sourceRates = Object.values(sourceGroups).map(
    (source) => source.resolveRate,
  )
  return {
    schemaVersion: 1,
    identitySha256: input.identitySha256,
    preset: input.preset,
    status: metricsComplete ? 'completed' : 'incomplete',
    cases: new Set(
      input.trials.map((trial) => `${trial.suiteId}:${trial.caseId}`),
    ).size,
    trials: input.trials.length,
    resolved: input.trials.filter((trial) => trial.evaluation.resolved).length,
    resolvedInitial: input.trials.filter((trial) => trial.resolvedInitial)
      .length,
    recovered: input.trials.filter((trial) => trial.recovered).length,
    metricsComplete,
    missingMetricTrials,
    levels,
    failureCategories,
    ...(sourceRates.length > 0
      ? {
          sources: sourceGroups,
          sourceMacroResolveRate:
            sourceRates.reduce((total, value) => total + value, 0) /
            sourceRates.length,
        }
      : {}),
    ...(metricsComplete
      ? { efficiency: summarizeBenchmarkRunGroup(comparable) }
      : {}),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(
      0,
      Date.parse(input.completedAt) - Date.parse(input.startedAt),
    ),
  }
}

function shareableReport(
  identitySha256: string,
  preset: RunBenchmarkGroupInput['preset'],
  summary: BenchmarkRunGroupSummaryReport,
  trials: BenchmarkShareableTrial[],
): BenchmarkShareableReport {
  return {
    schemaVersion: 1,
    identitySha256,
    preset,
    summary,
    trials,
    redaction: {
      policy: 'benchmark-shareable-v1',
      restrictedArtifacts: [
        'config.snapshot.json',
        'cases/*/*/trials/*/conversation.restricted.md',
        'cases/*/*/trials/*/session-transcript.restricted.md',
        'cases/*/*/case-result.restricted.json',
        'cases/*/*/trials/*/worker/**',
        'cases/*/*/trials/*/attempts/*/grader/*.restricted.json',
        'cases/*/*/trials/*/attempts/*/grader/stdout.log',
        'cases/*/*/trials/*/attempts/*/grader/stderr.log',
      ],
      removedFields: [
        'providerCredential',
        'absolutePaths',
        'evaluation.error',
        'rawTrace',
        'rawJsonl',
        'stderrTail',
        'privateCheckIds',
        'privateCommands',
        'commandStdout',
        'commandStderr',
        'graderInput',
      ],
    },
  }
}

function validateInput(input: RunBenchmarkGroupInput): void {
  if (input.selectedCases.length === 0)
    throw new Error('No benchmark cases selected')
  if (
    !Number.isSafeInteger(input.trialsPerCase) ||
    input.trialsPerCase < 1 ||
    input.trialsPerCase > 100
  ) {
    throw new Error('Benchmark trials per case must be between 1 and 100')
  }
  const keys = input.selectedCases.map(
    ({ suite, loadedCase }) => `${suite.suite.id}:${loadedCase.manifest.id}`,
  )
  if (new Set(keys).size !== keys.length)
    throw new Error('Benchmark case selection contains duplicates')
  if (input.protocol === 'strict' && input.feedbackVisibility) {
    throw new Error('Strict benchmark runs cannot set feedback visibility')
  }
  if (input.cohort && input.cohort.cohortHash !== input.cohortHash) {
    throw new Error('Benchmark cohort input does not match its identity hash')
  }
  if (input.cohort) verifyCohort(input.cohort)
}

async function writeState(
  directory: string,
  state: RunGroupState,
): Promise<void> {
  await writeJsonAtomic(path.join(directory, GROUP_STATE_FILE), state)
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
