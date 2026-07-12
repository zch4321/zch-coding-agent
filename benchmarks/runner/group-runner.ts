import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '../../electron/config/atomic-file'
import { toAgentCaseDescriptor } from '../adapters/native'
import { sha256Bytes } from '../cases/hash'
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
          toAgentCaseDescriptor(selected.loadedCase),
        ),
        writeFile(path.join(caseDirectory, 'task.txt'), manifest.task, 'utf8'),
      ])
      const trials = await trialRunner({
        loadedCase: selected.loadedCase,
        suiteIdentitySha256: selected.suite.suiteIdentitySha256,
        image: input.image,
        runtimeImageDigest: input.runtimeImageDigest,
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
  }
}

async function prepareRunGroupDirectory(input: {
  outputDirectory: string
  identity: BenchmarkRunGroupIdentity
  identitySha256: string
  config: RunBenchmarkGroupInput['config']
  priceSnapshot?: RunBenchmarkGroupInput['priceSnapshot']
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
