import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { loadNativeBenchmarkSuite } from '../adapters/native'
import {
  loadLatestMonthlySwebenchCatalog,
  loadLatestSweRebenchCatalog,
  loadMonthlySwebenchCatalog,
  loadSweRebenchCatalog,
  type ExternalDatasetCatalog,
} from '../adapters/external-datasets'
import { ExternalDockerRuntime } from '../adapters/external-docker-runtime'
import {
  loadExternalBenchmarkSuites,
  type ExternalAdapterRuntime,
} from '../adapters/external'
import type { LoadedAdapterSuite } from '../adapters/contracts'
import type {
  BenchmarkCohort,
  ExternalBenchmarkCandidate,
} from '../cohort/contracts'
import { buildRollingMixedCohort, verifyCohort } from '../cohort/selection'
import { BenchmarkCaseValidationError } from '../cases/loader'
import { validateBenchmarkPriceSnapshot } from '../metrics/aggregate'
import type { BenchmarkPriceSnapshot } from '../metrics/contracts'
import { inspectWorkerImage } from '../worker/capabilities'
import type { DockerWorkerCredential } from '../worker/contracts'
import {
  HeadlessConfigError,
  loadHeadlessConfig,
} from '../../electron/headless/config'
import {
  BENCHMARK_PRESETS,
  type BenchmarkRunGroupResult,
  type BenchmarkRunProgressEvent,
  type BenchmarkRunPreset,
  type RunBenchmarkGroupInput,
  type SelectedBenchmarkCase,
} from '../runner/group-contracts'
import { runBenchmarkGroup } from '../runner/group-runner'

const execFileAsync = promisify(execFile)
const DEFAULT_SUITE = 'manifests/core-harness-8/suite.json'
const MAX_PRICE_SNAPSHOT_BYTES = 1024 * 1024
const MAX_CLI_SUITES = 8
const MAX_CLI_CASES = 64

export interface BenchmarkCliArguments {
  preset: BenchmarkRunPreset
  configFile: string
  benchmarkRoot: string
  suiteFiles: string[]
  caseSelectors: string[]
  outputDirectory?: string
  image?: string
  trials?: number
  protocol: 'strict' | 'repair-once'
  feedbackVisibility?: 'public' | 'diagnostic'
  priceSnapshotFile?: string
  credentialMode: 'proxy' | 'direct'
  allowExternalNetwork: boolean
  cohortFile?: string
  seed?: string
  externalImageRetention: 'run' | 'keep'
}

export class BenchmarkCliError extends Error {
  readonly code = 'BENCHMARK_CLI_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'BenchmarkCliError'
  }
}

export interface BenchmarkCliOptions {
  environment?: NodeJS.ProcessEnv
  output?: Writable
  errorOutput?: Writable
  now?: () => Date
  sourceCommit?: string
  inspectImage?: typeof inspectWorkerImage
  groupRunner?: typeof runBenchmarkGroup
  signal?: AbortSignal
  loadExternalCatalogs?: (
    cohort?: BenchmarkCohort,
  ) => Promise<ExternalDatasetCatalog[]>
  createExternalRuntime?: (input: {
    cacheDirectory: string
    runtimeImage: string
    sourceCommit: string
    onProgress?: (message: string) => void
  }) => ExternalAdapterRuntime & {
    resolveImage: ExternalDockerRuntime['resolveImage']
  }
}

export function parseBenchmarkArguments(argv: string[]): BenchmarkCliArguments {
  if (argv[0] !== 'run') throw new BenchmarkCliError('Expected the run command')
  const single = new Map<string, string>()
  const repeated = new Map<string, string[]>()
  const repeatable = new Set(['--suite', '--case'])
  const allowed = new Set([
    '--preset',
    '--config',
    '--benchmark-root',
    '--suite',
    '--case',
    '--output',
    '--image',
    '--trials',
    '--protocol',
    '--feedback',
    '--price-snapshot',
    '--credential-mode',
    '--allow-external-network',
    '--cohort',
    '--seed',
    '--external-image-retention',
  ])
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !allowed.has(flag)) {
      throw new BenchmarkCliError(`Unknown argument: ${flag ?? ''}`)
    }
    if (!value || value.startsWith('--')) {
      throw new BenchmarkCliError(`Missing value for ${flag}`)
    }
    if (repeatable.has(flag)) {
      repeated.set(flag, [...(repeated.get(flag) ?? []), value])
    } else {
      if (single.has(flag))
        throw new BenchmarkCliError(`Duplicate argument: ${flag}`)
      single.set(flag, value)
    }
  }

  const preset = single.get('--preset')
  if (!isPreset(preset))
    throw new BenchmarkCliError('Invalid or missing --preset')
  const configFile = single.get('--config')
  if (!configFile)
    throw new BenchmarkCliError('Missing required argument: --config')
  const protocol = single.get('--protocol') ?? 'strict'
  if (protocol !== 'strict' && protocol !== 'repair-once') {
    throw new BenchmarkCliError('--protocol must be strict or repair-once')
  }
  const feedback = single.get('--feedback')
  if (feedback && feedback !== 'public' && feedback !== 'diagnostic') {
    throw new BenchmarkCliError('--feedback must be public or diagnostic')
  }
  if (protocol === 'strict' && feedback) {
    throw new BenchmarkCliError('--feedback requires repair-once protocol')
  }
  const credentialMode = single.get('--credential-mode') ?? 'proxy'
  if (credentialMode !== 'proxy' && credentialMode !== 'direct') {
    throw new BenchmarkCliError('--credential-mode must be proxy or direct')
  }
  const allowExternalNetwork = parseBoolean(
    single.get('--allow-external-network') ?? 'true',
    '--allow-external-network',
  )
  const cohortFile = single.get('--cohort')
  const seed = single.get('--seed')?.trim()
  const externalImageRetention =
    single.get('--external-image-retention') ?? 'run'
  if (externalImageRetention !== 'run' && externalImageRetention !== 'keep') {
    throw new BenchmarkCliError(
      '--external-image-retention must be run or keep',
    )
  }
  if (cohortFile && seed) {
    throw new BenchmarkCliError('--cohort and --seed cannot be used together')
  }
  if ((cohortFile || seed) && preset !== 'external') {
    throw new BenchmarkCliError('--cohort and --seed require --preset external')
  }
  if (single.has('--external-image-retention') && preset !== 'external') {
    throw new BenchmarkCliError(
      '--external-image-retention requires --preset external',
    )
  }
  if (seed && (seed.length > 256 || /[\r\n\0]/u.test(seed))) {
    throw new BenchmarkCliError('--seed is invalid')
  }
  const trialsValue = single.get('--trials')
  const trials = trialsValue
    ? positiveInteger(trialsValue, '--trials', 5)
    : undefined
  const benchmarkRoot = path.resolve(
    single.get('--benchmark-root') ?? 'benchmarks',
  )
  const suiteFiles = repeated.get('--suite') ?? [DEFAULT_SUITE]
  if (suiteFiles.length > MAX_CLI_SUITES) {
    throw new BenchmarkCliError(
      `At most ${MAX_CLI_SUITES} suites may be selected`,
    )
  }

  return {
    preset,
    configFile: path.resolve(configFile),
    benchmarkRoot,
    suiteFiles,
    caseSelectors: repeated.get('--case') ?? [],
    outputDirectory: single.get('--output')
      ? path.resolve(single.get('--output')!)
      : undefined,
    image: single.get('--image'),
    trials,
    protocol,
    feedbackVisibility:
      protocol === 'repair-once'
        ? ((feedback ?? 'public') as 'public' | 'diagnostic')
        : undefined,
    priceSnapshotFile: single.get('--price-snapshot')
      ? path.resolve(single.get('--price-snapshot')!)
      : undefined,
    credentialMode,
    allowExternalNetwork,
    cohortFile: cohortFile ? path.resolve(cohortFile) : undefined,
    seed: seed || undefined,
    externalImageRetention,
  }
}

export async function runBenchmarkCli(
  argv: string[],
  options: BenchmarkCliOptions = {},
): Promise<{ exitCode: number; result?: BenchmarkRunGroupResult }> {
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  let externalRuntime:
    | (ExternalAdapterRuntime & {
        resolveImage: ExternalDockerRuntime['resolveImage']
      })
    | undefined
  let cleanupExternalImages = false
  try {
    const args = parseBenchmarkArguments(argv)
    cleanupExternalImages =
      args.preset === 'external' && args.externalImageRetention === 'run'
    const environment = options.environment ?? process.env
    const sourceCommit = options.sourceCommit ?? (await currentSourceCommit())
    const [config, priceSnapshot] = await Promise.all([
      loadHeadlessConfig(args.configFile),
      args.priceSnapshotFile
        ? loadPriceSnapshot(args.priceSnapshotFile)
        : Promise.resolve(undefined),
    ])
    const credentialValue = environment[config.provider.credentialEnv]?.trim()
    if (!credentialValue) {
      throw new BenchmarkCliError(
        `Provider credential environment variable is missing: ${config.provider.credentialEnv}`,
      )
    }
    if (
      priceSnapshot &&
      (priceSnapshot.providerId !== config.provider.id ||
        priceSnapshot.model !== config.provider.model)
    ) {
      throw new BenchmarkCliError(
        'Price snapshot provider/model does not match the Headless config',
      )
    }
    const image =
      args.image ??
      environment.ZCH_WORKER_IMAGE ??
      `zch-agent-headless:${sourceCommit.slice(0, 12)}`
    const imageIdentity = await (options.inspectImage ?? inspectWorkerImage)(
      image,
      sourceCommit,
    )
    const now = options.now?.() ?? new Date()
    const outputDirectory =
      args.outputDirectory ??
      path.resolve(
        args.benchmarkRoot,
        'results',
        `${timestamp(now)}-${args.preset}`,
      )
    if (args.preset === 'external') {
      externalRuntime =
        options.createExternalRuntime?.({
          cacheDirectory: path.join(args.benchmarkRoot, '.cache', 'external'),
          runtimeImage: image,
          sourceCommit,
          onProgress: (message) =>
            writeProgress(errorOutput, terminalText(message)),
        }) ??
        new ExternalDockerRuntime({
          cacheDirectory: path.join(args.benchmarkRoot, '.cache', 'external'),
          runtimeImage: image,
          sourceCommit,
          onProgress: (message) =>
            writeProgress(errorOutput, terminalText(message)),
        })
    }
    const external =
      args.preset === 'external'
        ? await prepareExternalRun({
            args,
            options,
            now,
            runtime: externalRuntime!,
            onCandidate: (candidate) =>
              writeProgress(
                errorOutput,
                `preparing ${terminalText(candidate.source)} project ${terminalText(candidate.repository)} (${terminalText(candidate.caseId)})`,
              ),
            onCandidateHeartbeat: (candidate, elapsedMs) =>
              writeProgress(
                errorOutput,
                `still preparing ${terminalText(candidate.repository)} (${terminalText(candidate.caseId)}), ${formatDuration(elapsedMs)} elapsed`,
              ),
          })
        : undefined
    const suites: LoadedAdapterSuite[] = external
      ? external.suites
      : await Promise.all(
          args.suiteFiles.map((suiteFile) =>
            loadNativeBenchmarkSuite({
              benchmarkRoot: args.benchmarkRoot,
              suiteFile,
            }),
          ),
        )
    const selectedCases = selectCases({
      suites,
      selectors: args.caseSelectors,
      caseLimit: BENCHMARK_PRESETS[args.preset].caseLimit,
    })
    const credential = credentialForRun(
      args.credentialMode,
      credentialValue,
      args.allowExternalNetwork,
    )
    const groupInput: RunBenchmarkGroupInput = {
      preset: args.preset,
      selectedCases,
      image,
      runtimeImageDigest: imageIdentity.digest,
      sourceCommit,
      config,
      credential,
      outputDirectory,
      trialsPerCase: args.trials ?? BENCHMARK_PRESETS[args.preset].trials,
      protocol: args.protocol,
      feedbackVisibility: args.feedbackVisibility,
      priceSnapshot,
      cohortHash: external?.cohort.cohortHash,
      cohort: external?.cohort,
      signal: options.signal,
      onProgress: (event) =>
        writeProgress(errorOutput, formatProgressEvent(event)),
    }
    writeProgress(
      errorOutput,
      `starting ${args.preset}: ${selectedCases.length} cases x ${groupInput.trialsPerCase} trials (${selectedCases.length * groupInput.trialsPerCase} total)`,
    )
    const result = await (options.groupRunner ?? runBenchmarkGroup)(groupInput)
    output.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: result.summary.status,
        preset: result.summary.preset,
        cases: result.summary.cases,
        trials: result.summary.trials,
        resolved: result.summary.resolved,
        directory: result.directory,
        report: path.join(result.directory, 'shareable-report.json'),
      })}\n`,
    )
    return { exitCode: result.summary.status === 'completed' ? 0 : 2, result }
  } catch (error) {
    errorOutput.write(
      `[benchmark] ${error instanceof Error ? error.message : 'Unexpected failure'}\n`,
    )
    const invalidInput =
      error instanceof BenchmarkCliError ||
      error instanceof HeadlessConfigError ||
      error instanceof BenchmarkCaseValidationError
    return { exitCode: options.signal?.aborted ? 130 : invalidInput ? 4 : 2 }
  } finally {
    if (cleanupExternalImages && externalRuntime?.cleanupImages) {
      writeProgress(errorOutput, 'cleaning up images created by this run')
      try {
        const cleanup = await externalRuntime.cleanupImages()
        writeProgress(
          errorOutput,
          `image cleanup completed: ${cleanup.removed} removed, ${cleanup.failed} failed`,
        )
      } catch {
        writeProgress(errorOutput, 'image cleanup failed')
      }
    }
  }
}

function selectCases(input: {
  suites: LoadedAdapterSuite[]
  selectors: string[]
  caseLimit: number | null
}): SelectedBenchmarkCase[] {
  const available = input.suites.flatMap((suite) =>
    suite.cases.map((loadedCase) => ({ suite, loadedCase })),
  )
  const keys = available.map(
    ({ suite, loadedCase }) => `${suite.suite.id}:${loadedCase.manifest.id}`,
  )
  if (new Set(keys).size !== keys.length) {
    throw new BenchmarkCliError(
      'Selected suites contain duplicate case identities',
    )
  }
  let selected = available
  if (input.selectors.length > 0) {
    selected = input.selectors.map((selector) => {
      const matches = available.filter(({ suite, loadedCase }) =>
        selector.includes(':')
          ? `${suite.suite.id}:${loadedCase.manifest.id}` === selector
          : loadedCase.manifest.id === selector,
      )
      if (matches.length !== 1) {
        throw new BenchmarkCliError(
          matches.length === 0
            ? `Unknown benchmark case: ${selector}`
            : `Ambiguous benchmark case: ${selector}`,
        )
      }
      return matches[0]!
    })
  }
  const limit = input.caseLimit
  selected =
    input.selectors.length > 0 || limit === null
      ? selected
      : selected.slice(0, limit)
  if (selected.length === 0)
    throw new BenchmarkCliError('No benchmark cases selected')
  const selectedKeys = selected.map(
    ({ suite, loadedCase }) => `${suite.suite.id}:${loadedCase.manifest.id}`,
  )
  if (new Set(selectedKeys).size !== selectedKeys.length) {
    throw new BenchmarkCliError('Benchmark case selection contains duplicates')
  }
  if (selected.length > MAX_CLI_CASES) {
    throw new BenchmarkCliError(
      `Benchmark selection exceeds the ${MAX_CLI_CASES}-case CLI limit`,
    )
  }
  return selected
}

async function loadPriceSnapshot(
  filePath: string,
): Promise<BenchmarkPriceSnapshot> {
  const raw = await readFile(filePath)
  if (raw.byteLength > MAX_PRICE_SNAPSHOT_BYTES) {
    throw new BenchmarkCliError('Price snapshot exceeds 1 MiB')
  }
  let value: BenchmarkPriceSnapshot
  try {
    value = JSON.parse(raw.toString('utf8')) as BenchmarkPriceSnapshot
  } catch {
    throw new BenchmarkCliError('Price snapshot is not valid JSON')
  }
  try {
    validateBenchmarkPriceSnapshot(value)
  } catch (error) {
    throw new BenchmarkCliError(
      error instanceof Error ? error.message : 'Price snapshot is invalid',
    )
  }
  return value
}

function credentialForRun(
  mode: 'proxy' | 'direct',
  credential: string,
  allowExternalNetwork: boolean,
): DockerWorkerCredential {
  return mode === 'proxy'
    ? { mode, upstreamCredential: credential, allowExternalNetwork }
    : { mode, credential }
}

async function currentSourceCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      windowsHide: true,
    })
    const commit = stdout.trim()
    if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('invalid commit')
    return commit
  } catch {
    throw new BenchmarkCliError('Unable to resolve the current source commit')
  }
}

function timestamp(value: Date): string {
  return value.toISOString().replaceAll(':', '').replaceAll('.', '-')
}

function positiveInteger(value: string, flag: string, maximum: number): number {
  if (!/^\d+$/u.test(value))
    throw new BenchmarkCliError(`${flag} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BenchmarkCliError(`${flag} must be between 1 and ${maximum}`)
  }
  return parsed
}

function parseBoolean(value: string, flag: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new BenchmarkCliError(`${flag} must be true or false`)
}

function isPreset(value: string | undefined): value is BenchmarkRunPreset {
  return (
    value === 'smoke' ||
    value === 'daily' ||
    value === 'full' ||
    value === 'external'
  )
}

async function prepareExternalRun(input: {
  args: BenchmarkCliArguments
  options: BenchmarkCliOptions
  now: Date
  onCandidate?: (candidate: ExternalBenchmarkCandidate) => void
  onCandidateHeartbeat?: (
    candidate: ExternalBenchmarkCandidate,
    elapsedMs: number,
  ) => void
  runtime: ExternalAdapterRuntime & {
    resolveImage: ExternalDockerRuntime['resolveImage']
  }
}): Promise<{ cohort: BenchmarkCohort; suites: LoadedAdapterSuite[] }> {
  const runtime = input.runtime
  const resolveImage = async (candidate: ExternalBenchmarkCandidate) => {
    input.onCandidate?.(candidate)
    const startedMs = performance.now()
    const heartbeat = setInterval(() => {
      input.onCandidateHeartbeat?.(
        candidate,
        Math.max(0, performance.now() - startedMs),
      )
    }, 15_000)
    heartbeat.unref()
    try {
      return await runtime.resolveImage(candidate)
    } finally {
      clearInterval(heartbeat)
    }
  }
  const cohort = input.args.cohortFile
    ? await loadCohortFile(input.args.cohortFile)
    : undefined
  const catalogs = await (
    input.options.loadExternalCatalogs ?? defaultExternalCatalogLoader
  )(cohort)
  let resolvedCohort = cohort
  if (resolvedCohort) {
    for (const cohortCase of resolvedCohort.cases) {
      const candidate = catalogs
        .find((catalog) => catalog.release.source === cohortCase.source)
        ?.candidates.find((entry) => entry.caseId === cohortCase.caseId)
      if (!candidate) {
        throw new BenchmarkCliError(
          `Pinned cohort case is unavailable: ${cohortCase.caseId}`,
        )
      }
      const image = await resolveImage(candidate)
      if (
        !image.eligible ||
        image.officialDigest !== cohortCase.officialImage.digest ||
        image.agentImageDigest !== cohortCase.agentImageDigest
      ) {
        throw new BenchmarkCliError(
          `Pinned cohort image mismatch: ${cohortCase.caseId}`,
        )
      }
    }
  } else {
    resolvedCohort = await buildRollingMixedCohort({
      releases: catalogs.map((catalog) => catalog.release),
      candidates: catalogs.flatMap((catalog) => catalog.candidates),
      seed: input.args.seed,
      now: () => input.now,
      initialExclusions: catalogs.flatMap((catalog) =>
        catalog.exclusions.map((entry) => ({
          source: catalog.release.source,
          caseId: entry.caseId,
          reason: entry.reason,
        })),
      ),
      resolveImage: (candidate) => {
        return resolveImage(candidate)
      },
    })
  }
  return {
    cohort: resolvedCohort,
    suites: loadExternalBenchmarkSuites({
      cohort: resolvedCohort,
      catalogs,
      runtime,
    }),
  }
}

function formatProgressEvent(event: BenchmarkRunProgressEvent): string {
  const caseLabel = `${terminalText(event.suiteId)}/${terminalText(event.caseId)}`
  if (event.phase === 'case-start') {
    return `[case ${event.caseIndex}/${event.caseCount}] ${caseLabel} project=${terminalText(event.repository)}`
  }
  if (event.phase === 'trial-start') {
    return `[case ${event.caseIndex}/${event.caseCount}] [trial ${event.trialIndex}/${event.trialCount}] ${caseLabel} started`
  }
  if (event.phase === 'trial-complete') {
    const outcome = event.resolved ? 'resolved' : 'unresolved'
    const reuse = event.reused ? ' (cached)' : ''
    return `[case ${event.caseIndex}/${event.caseCount}] [trial ${event.trialIndex}/${event.trialCount}] ${caseLabel} ${event.level} ${outcome} in ${formatDuration(event.durationMs)}${reuse}`
  }
  return `[case ${event.caseIndex}/${event.caseCount}] ${caseLabel} completed: ${event.resolved}/${event.trialCount} resolved in ${formatDuration(event.durationMs)}`
}

function writeProgress(output: Writable, message: string): void {
  output.write(`[benchmark] ${message}\n`)
}

function terminalText(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      ? ' '
      : character
  }).join('')
  return withoutControls.replace(/\s+/gu, ' ').trim().slice(0, 240)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

async function defaultExternalCatalogLoader(
  cohort?: BenchmarkCohort,
): Promise<ExternalDatasetCatalog[]> {
  if (!cohort) {
    return Promise.all([
      loadLatestMonthlySwebenchCatalog(),
      loadLatestSweRebenchCatalog(),
    ])
  }
  const monthly = cohort.sources.find(
    (source) => source.source === 'monthly-swebench',
  )
  const rebench = cohort.sources.find(
    (source) => source.source === 'swe-rebench',
  )
  if (!monthly || !rebench) {
    throw new BenchmarkCliError(
      'Pinned cohort is missing an external dataset release',
    )
  }
  return Promise.all([
    loadMonthlySwebenchCatalog(monthly),
    loadSweRebenchCatalog(rebench),
  ])
}

async function loadCohortFile(filePath: string): Promise<BenchmarkCohort> {
  const raw = await readFile(filePath)
  if (raw.byteLength > 4 * 1024 * 1024) {
    throw new BenchmarkCliError('Benchmark cohort exceeds 4 MiB')
  }
  let cohort: BenchmarkCohort
  try {
    cohort = JSON.parse(raw.toString('utf8')) as BenchmarkCohort
    if (
      cohort?.schemaVersion !== 1 ||
      cohort.kind !== 'rolling-mixed-16' ||
      !Array.isArray(cohort.sources) ||
      !Array.isArray(cohort.cases) ||
      !Array.isArray(cohort.exclusions)
    ) {
      throw new Error('shape')
    }
    verifyCohort(cohort)
  } catch {
    throw new BenchmarkCliError('Benchmark cohort is invalid')
  }
  return cohort
}
