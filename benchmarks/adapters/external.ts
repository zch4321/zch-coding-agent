import path from 'node:path'
import type {
  AgentCaseDescriptor,
  BenchmarkCase,
  LoadedBenchmarkCase,
} from '../cases/contracts'
import { BENCHMARK_CASE_INTERNAL } from '../cases/contracts'
import { sha256Bytes } from '../cases/hash'
import type {
  BenchmarkCohort,
  BenchmarkCohortCase,
  ExternalBenchmarkCandidate,
  ExternalBenchmarkSource,
} from '../cohort/contracts'
import { candidateHash, verifyCohort } from '../cohort/selection'
import { sha256Canonical } from '../cohort/hash'
import type { IsolatedGraderRunResult } from '../grader/contracts'
import type { RunIsolatedGraderInput } from '../grader/coordinator'
import type {
  BenchmarkCaseAdapter,
  BenchmarkPreparedWorkspace,
  LoadedAdapterSuite,
} from './contracts'

export interface ExternalPreparedWorkspace extends BenchmarkPreparedWorkspace {
  mount: { kind: 'volume'; name: string; containerPath: string }
}

export interface ExternalAdapterRuntime {
  prepare(input: {
    candidate: ExternalBenchmarkCandidate
    cohortCase: BenchmarkCohortCase
    destination: string
    agentImageReference: string
  }): Promise<ExternalPreparedWorkspace>
  capturePatch(input: {
    candidate: ExternalBenchmarkCandidate
    cohortCase: BenchmarkCohortCase
    workspace: ExternalPreparedWorkspace
    maxPatchBytes: number
    agentImageReference: string
  }): Promise<string>
  grade(input: {
    candidate: ExternalBenchmarkCandidate
    cohortCase: BenchmarkCohortCase
    graderInput: RunIsolatedGraderInput
    targetGroupIds: string[]
    agentImageReference: string
  }): Promise<IsolatedGraderRunResult>
  dispose(workspaces: ExternalPreparedWorkspace[]): Promise<void>
  cleanupImages?(): Promise<{ removed: number; failed: number }>
}

interface ExternalCasePrivate {
  candidate: ExternalBenchmarkCandidate
  cohortCase: BenchmarkCohortCase
  agentImageReference: string
  targetGroupIds: string[]
}

export interface LoadExternalSuitesInput {
  cohort: BenchmarkCohort
  catalogs: Array<{
    release: {
      source: ExternalBenchmarkSource
      dataset: string
      release: string
      commit: string
    }
    candidates: ExternalBenchmarkCandidate[]
  }>
  runtime: ExternalAdapterRuntime
}

/** Loads the requested benchmark adapters and applies the verified cohort selection. */
export function loadExternalBenchmarkSuites(
  input: LoadExternalSuitesInput,
): LoadedAdapterSuite[] {
  verifyCohort(input.cohort)
  const bySource = new Map(
    input.catalogs.map((catalog) => [catalog.release.source, catalog]),
  )
  return (['monthly-swebench', 'swe-rebench'] as const).map((source) => {
    const catalog = bySource.get(source)
    if (!catalog) throw new Error(`Missing pinned ${source} catalog`)
    const sourceCases = input.cohort.cases.filter(
      (entry) => entry.source === source,
    )
    const privateCases = new WeakMap<LoadedBenchmarkCase, ExternalCasePrivate>()
    const workspaces = new WeakMap<
      LoadedBenchmarkCase,
      ExternalPreparedWorkspace[]
    >()
    const adapter = createExternalAdapter(
      source,
      input.runtime,
      privateCases,
      workspaces,
    )
    const cases = sourceCases.map((cohortCase) => {
      if (
        cohortCase.dataset !== catalog.release.dataset ||
        cohortCase.release !== catalog.release.release ||
        cohortCase.commit !== catalog.release.commit
      ) {
        throw new Error(
          `Cohort dataset identity mismatch for ${cohortCase.caseId}`,
        )
      }
      const candidate = catalog.candidates.find(
        (entry) => entry.caseId === cohortCase.caseId,
      )
      if (!candidate || candidateHash(candidate) !== cohortCase.caseHash) {
        throw new Error(`Cohort case hash mismatch for ${cohortCase.caseId}`)
      }
      const loaded = externalLoadedCase(input.cohort, cohortCase, candidate)
      privateCases.set(loaded.loadedCase, loaded.privateCase)
      return loaded.loadedCase
    })
    const suite = cases[0]!.manifest.suite
    const suiteContract = {
      schemaVersion: 1 as const,
      id: suite.id,
      revision: suite.revision,
      title: `${source} rolling cohort`,
      targetCaseCount: 8,
      cases: cases.map((loadedCase) => ({
        id: loadedCase.manifest.id,
        manifest: `external/${source}/${loadedCase.manifest.id}.json`,
        manifestSha256: loadedCase.identity.manifestSha256,
      })),
    }
    const suiteSha256 = sha256Canonical(suiteContract)
    return {
      suite: suiteContract,
      suiteSha256,
      cases,
      adapter: { id: source, revision: adapter.revision },
      caseAdapter: adapter,
      suiteIdentitySha256: sha256Canonical({
        schemaVersion: 2,
        adapter: { id: source, revision: adapter.revision },
        suiteSha256,
        cohortHash: input.cohort.cohortHash,
      }),
    }
  })
}

function createExternalAdapter(
  source: ExternalBenchmarkSource,
  runtime: ExternalAdapterRuntime,
  privateCases: WeakMap<LoadedBenchmarkCase, ExternalCasePrivate>,
  workspaces: WeakMap<LoadedBenchmarkCase, ExternalPreparedWorkspace[]>,
): BenchmarkCaseAdapter {
  const getPrivate = (loadedCase: LoadedBenchmarkCase): ExternalCasePrivate => {
    const value = privateCases.get(loadedCase)
    if (!value)
      throw new Error('External benchmark private case is unavailable')
    return value
  }
  return {
    id: source,
    revision:
      source === 'monthly-swebench' ? 'monthly-swebench-v1' : 'swe-rebench-v1',
    executionImage({ loadedCase }) {
      const value = getPrivate(loadedCase)
      return {
        image: value.agentImageReference,
        runtimeImageDigest: value.cohortCase.agentImageDigest,
      }
    },
    toAgentCaseDescriptor(loadedCase) {
      const manifest = loadedCase.manifest
      return {
        schemaVersion: 1,
        caseId: manifest.id,
        suiteId: manifest.suite.id,
        suiteRevision: manifest.suite.revision,
        task: manifest.task,
        publicChecks: [],
        modificationScope: structuredClone(manifest.modificationScope),
        resources: structuredClone(manifest.resources),
      }
    },
    async prepareWorkspace({ loadedCase, destination }) {
      const value = getPrivate(loadedCase)
      const prepared = await runtime.prepare({
        ...value,
        destination,
      })
      workspaces.set(loadedCase, [
        ...(workspaces.get(loadedCase) ?? []),
        prepared,
      ])
      return prepared
    },
    capturePatch({ loadedCase, workspace }) {
      const value = getPrivate(loadedCase)
      return runtime.capturePatch({
        ...value,
        workspace: workspace as ExternalPreparedWorkspace,
        maxPatchBytes: loadedCase.manifest.modificationScope.maxPatchBytes,
      })
    },
    runGrader(graderInput) {
      const value = getPrivate(graderInput.loadedCase)
      return runtime.grade({ ...value, graderInput })
    },
    async disposeCaseResources(loadedCase) {
      const prepared = workspaces.get(loadedCase) ?? []
      workspaces.delete(loadedCase)
      await runtime.dispose(prepared)
    },
  }
}

function externalLoadedCase(
  cohort: BenchmarkCohort,
  cohortCase: BenchmarkCohortCase,
  candidate: ExternalBenchmarkCandidate,
): { loadedCase: LoadedBenchmarkCase; privateCase: ExternalCasePrivate } {
  const id = safeCaseId(cohortCase.source, cohortCase.caseId)
  const suiteId = `${cohortCase.source}-${cohortCase.release.replaceAll('_', '-')}`
  const targetCount =
    candidate.privatePayload.kind === 'swe-rebench'
      ? Math.min(16, candidate.privatePayload.failToPass.length)
      : 1
  const targetGroupIds = Array.from(
    { length: Math.max(1, targetCount) },
    (_, index) => `target-${index + 1}`,
  )
  const agentImageReference = `zch-external/${cohortCase.source}:${cohortCase.caseHash.slice(0, 20)}`
  const manifest: BenchmarkCase = {
    schemaVersion: 1,
    id,
    suite: { id: suiteId, revision: safeRevision(cohortCase.release) },
    kind: cohortCase.classification === 'bug-fix' ? 'bug-fix' : 'feature',
    task: candidate.problemStatement,
    repository: {
      source: {
        kind: 'dataset',
        locator: `${cohortCase.dataset}:${cohortCase.caseId}`,
        revision: cohortCase.commit,
        license: cohortCase.source === 'monthly-swebench' ? 'MIT' : 'CC-BY-4.0',
      },
      archive: `external/${cohortCase.caseHash}.restricted`,
      archiveSha256: sha256Bytes(JSON.stringify(candidate.privatePayload)),
      treeSha256: sha256Bytes(
        `${candidate.baseCommit}\0${cohortCase.caseHash}`,
      ),
    },
    platform: {
      os: 'linux',
      architecture: 'x64',
      libc: 'glibc',
      nodeMajor: 24,
    },
    caseImage: {
      reference: agentImageReference,
      digest: cohortCase.agentImageDigest,
    },
    setup: [],
    publicChecks: [
      {
        id: 'regression',
        title: 'Upstream regression verifier',
        acceptanceGroupId: 'regression',
        command: {
          executable: 'upstream-verifier',
          args: [],
          timeoutMs: 300_000,
          maxOutputBytes: 4_194_304,
        },
      },
    ],
    grader: {
      adapter: 'native-command-v1',
      protocolVersion: 1,
      privateSpecSha256: cohortCase.caseHash,
    },
    acceptanceGroups: targetGroupIds.map((groupId, index) => ({
      id: groupId,
      title: `Target behavior shard ${index + 1}`,
      critical: true,
      weight: 1,
    })),
    feedbackPolicy: { allowed: 'diagnostic', repairOnceAllowed: true },
    modificationScope: {
      allowedPaths: ['**'],
      deniedPaths: ['.git/**'],
      maxChangedFiles: 1_000,
      maxPatchBytes: 2 * 1024 * 1024,
    },
    resources: {
      wallTimeMs: 30 * 60_000,
      cpus: 2,
      memoryBytes: 8 * 1024 * 1024 * 1024,
      pids: 512,
      diskBytes: 8 * 1024 * 1024 * 1024,
      maxAgentSteps: 64,
      maxContextTokens: 131_072,
    },
    quality: {
      baselineExpected: 'fail',
      minimumRejectedMutants: 2,
      repetitions: 3,
      review: {
        status: 'reviewed',
        reviewer: 'upstream-dataset',
        reviewedAt: cohort.createdAt,
        method:
          'Upstream dataset quality is trusted; only machine compatibility wiring is checked.',
      },
    },
  }
  const manifestSha256 = sha256Canonical(manifest)
  const loadedCase: LoadedBenchmarkCase = {
    manifest,
    identity: {
      manifestSha256,
      archiveSha256: manifest.repository.archiveSha256,
      treeSha256: manifest.repository.treeSha256,
      privateSpecSha256: cohortCase.caseHash,
      external: {
        adapterRevision: cohortCase.adapterRevision,
        dataset: cohortCase.dataset,
        release: cohortCase.release,
        commit: cohortCase.commit,
        caseHash: cohortCase.caseHash,
        officialImageDigest: cohortCase.officialImage.digest,
        agentImageDigest: cohortCase.agentImageDigest,
        cohortHash: cohort.cohortHash,
      },
    },
    [BENCHMARK_CASE_INTERNAL]: {
      archivePath: path.resolve('external-dataset-private'),
      privateSpecPath: path.resolve('external-dataset-private'),
    },
  }
  return {
    loadedCase,
    privateCase: { candidate, cohortCase, agentImageReference, targetGroupIds },
  }
}

function safeCaseId(source: ExternalBenchmarkSource, raw: string): string {
  const prefix = source === 'monthly-swebench' ? 'monthly' : 'rebench'
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
  return `${prefix}-${slug}-${sha256Bytes(raw).slice(0, 12)}`
}

function safeRevision(release: string): string {
  return release.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')
}

/** Converts a loaded benchmark case into the agent-visible descriptor supplied by its adapter. */
export function externalAgentDescriptor(
  loadedCase: LoadedBenchmarkCase,
  adapter: BenchmarkCaseAdapter,
): AgentCaseDescriptor {
  return adapter.toAgentCaseDescriptor(loadedCase)
}
