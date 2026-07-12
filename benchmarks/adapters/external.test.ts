import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sha256Bytes } from '../cases/hash'
import type {
  BenchmarkCohort,
  BenchmarkCohortCase,
  ExternalBenchmarkCandidate,
  ExternalBenchmarkSource,
} from '../cohort/contracts'
import { sha256Canonical } from '../cohort/hash'
import { candidateHash } from '../cohort/selection'
import type { IsolatedGraderRunResult } from '../grader/contracts'
import { scoreIsolatedGrader } from '../grader/scoring'
import {
  externalVolumeInitializerArgs,
  parseExternalVerifier,
} from './external-docker-runtime'
import {
  loadExternalBenchmarkSuites,
  type ExternalAdapterRuntime,
} from './external'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('external benchmark adapters', () => {
  it('keeps recursive workspace ownership changes out of image layers', async () => {
    const dockerfile = await readFile(
      path.resolve('benchmarks/docker/external-overlay.Dockerfile'),
      'utf8',
    )

    expect(dockerfile).not.toMatch(/chown\s+-R/iu)
    expect(dockerfile).toContain('chown 10001:10001 /home/zch')

    const args = externalVolumeInitializerArgs({
      container: 'volume-init',
      image: 'task-image',
      volume: 'workspace-volume',
      workspace: '/app/project with spaces',
    })
    expect(args).toContain('chown -R 10001:10001 -- "$1"')
    expect(args.at(-1)).toBe('/app/project with spaces')
    expect(args.join(' ')).not.toContain('chown -R 10001:10001 -- /app/project')
  })

  it('loads a pinned 8+8 cohort while keeping gold and verifier data outside the Agent descriptor', async () => {
    const candidates = fixtureCandidates()
    const cohort = fixtureCohort(candidates)
    const dispose = vi.fn(async () => undefined)
    const runtime: ExternalAdapterRuntime = {
      prepare: async ({ destination }) => ({
        directory: destination,
        mount: {
          kind: 'volume',
          name: 'fixture-volume',
          containerPath: '/testbed',
        },
      }),
      capturePatch: async () => '',
      grade: async () => graderResult(),
      dispose,
    }
    const suites = loadExternalBenchmarkSuites({
      cohort,
      catalogs: [
        {
          release: release('monthly-swebench'),
          candidates: candidates.filter(
            (candidate) => candidate.source === 'monthly-swebench',
          ),
        },
        {
          release: release('swe-rebench'),
          candidates: candidates.filter(
            (candidate) => candidate.source === 'swe-rebench',
          ),
        },
      ],
      runtime,
    })

    expect(suites).toHaveLength(2)
    expect(suites.every((suite) => suite.cases.length === 8)).toBe(true)
    const rebench = suites.find((suite) => suite.adapter.id === 'swe-rebench')!
    const descriptor = rebench.caseAdapter.toAgentCaseDescriptor(
      rebench.cases[0]!,
    )
    expect(descriptor.publicChecks).toEqual([])
    expect(JSON.stringify(descriptor)).not.toMatch(
      /gold solution|private target|test_patch|failToPass|upstream-verifier/iu,
    )
    expect(rebench.cases[0]!.identity.external).toMatchObject({
      cohortHash: cohort.cohortHash,
      adapterRevision: 'swe-rebench-v1',
      officialImageDigest: digest('a'),
      agentImageDigest: digest('b'),
    })
    expect(
      scoreIsolatedGrader({
        loadedCase: rebench.cases[0]!,
        grader: partialGraderResult(rebench.cases[0]!.manifest.id),
      }).level,
    ).toBe('L4')

    const prepared = await rebench.caseAdapter.prepareWorkspace({
      loadedCase: rebench.cases[0]!,
      destination: 'fixture',
    })
    expect(prepared.mount).toMatchObject({
      kind: 'volume',
      containerPath: '/testbed',
    })
    await rebench.caseAdapter.disposeCaseResources?.(rebench.cases[0]!)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('normalizes Monthly role output and partial SWE-rebench target results', () => {
    const monthly = fixtureCandidates()[0]!
    const monthlyResult = parseExternalVerifier(monthly, {
      exitCode: 1,
      stdout:
        '[REGRESSION_DIRECT] existing: PASS\n[FAIL2PASS_CORE] first: PASS\n[FAIL2PASS_EDGE] second: FAIL\n',
      stderr: '',
    })
    expect(monthlyResult).toMatchObject({
      regressionPassed: true,
      targetResults: [true, false],
    })

    const rebench = fixtureCandidates()[8]!
    const rebenchResult = parseExternalVerifier(rebench, {
      exitCode: 1,
      stdout: 'private target 1 PASSED\nprivate target 2 FAILED\n',
      stderr: '',
    })
    expect(rebenchResult).toMatchObject({
      regressionPassed: true,
      targetResults: [true, false],
    })
  })
})

function fixtureCandidates(): ExternalBenchmarkCandidate[] {
  return (['monthly-swebench', 'swe-rebench'] as const).flatMap((source) =>
    Array.from({ length: 8 }, (_, index) => candidate(source, index)),
  )
}

function candidate(
  source: ExternalBenchmarkSource,
  index: number,
): ExternalBenchmarkCandidate {
  const common = {
    ...release(source),
    caseId: `${source}-case-${index}`,
    repository: `${source}/repo-${index}`,
    classification: 'bug-fix' as const,
    language: index % 2 ? 'python' : 'go',
    problemStatement: `Fix public problem ${index}`,
    baseCommit: 'c'.repeat(40),
    patchBytes: 100 + index,
    officialImageReference: `fixture/${source}-${index}:latest`,
  }
  return source === 'monthly-swebench'
    ? {
        ...common,
        privatePayload: {
          kind: 'monthly-swebench',
          archiveFile: 'bugfix.tar.zst',
          instructionPath: `${index}/instruction.md`,
          taskPath: `${index}/task.toml`,
          environmentPath: `${index}/environment/`,
          solutionPath: `${index}/solution/`,
          testsPath: `${index}/tests/`,
        },
      }
    : {
        ...common,
        privatePayload: {
          kind: 'swe-rebench',
          solutionPatch: 'gold solution',
          testPatch: 'private tests',
          failToPass: ['private target 1', 'private target 2'],
          passToPass: [],
          verifier: { testCommand: 'private verifier' },
        },
      }
}

function fixtureCohort(
  candidates: ExternalBenchmarkCandidate[],
): BenchmarkCohort {
  const cases: BenchmarkCohortCase[] = candidates.map((candidate) => ({
    source: candidate.source,
    dataset: candidate.dataset,
    release: candidate.release,
    commit: candidate.commit,
    adapterRevision: candidate.adapterRevision,
    caseId: candidate.caseId,
    repository: candidate.repository,
    classification: candidate.classification,
    language: candidate.language,
    patchScale: 'small',
    caseHash: candidateHash(candidate),
    officialImage: {
      reference: candidate.officialImageReference,
      digest: digest('a'),
    },
    agentImageDigest: digest('b'),
  }))
  const draft = {
    schemaVersion: 1 as const,
    kind: 'rolling-mixed-16' as const,
    createdAt: '2026-07-12T00:00:00.000Z',
    seed: 'fixture-seed',
    sources: [release('monthly-swebench'), release('swe-rebench')],
    cases,
    exclusions: [],
  }
  return { ...draft, cohortHash: sha256Canonical(draft) }
}

function release(source: ExternalBenchmarkSource) {
  return {
    source,
    dataset: `fixture/${source}`,
    release: '2026-05',
    commit: 'd'.repeat(40),
    adapterRevision: `${source}-v1`,
  }
}

function graderResult(): IsolatedGraderRunResult {
  return {
    schemaVersion: 1,
    status: 'attempted',
    graderRevision: 'isolated-grader-v1',
    graderImageDigest: digest('b'),
    inputSha256: sha256Bytes('fixture'),
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:00.000Z',
    durationMs: 0,
    patch: {
      sha256: sha256Bytes(''),
      present: false,
      applies: true,
      scopeCompliant: true,
      hygienePassed: true,
    },
    sandbox: {
      networkDisabled: true,
      readOnlyRoot: true,
      nonRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      boundedResources: true,
      privateInputReadOnly: true,
      dockerSocketAbsent: true,
    },
    inputImmutable: true,
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: 'fixture',
      stdoutPath: 'fixture/stdout',
      stderrPath: 'fixture/stderr',
      coordinatorResultPath: 'fixture/result',
    },
  }
}

function partialGraderResult(caseId: string): IsolatedGraderRunResult {
  const result = graderResult()
  const command = (
    stage: 'setup' | 'public' | 'private',
    id: string,
    passed: boolean,
    acceptanceGroupId?: string,
  ) => ({
    stage,
    id,
    ...(acceptanceGroupId ? { acceptanceGroupId } : {}),
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: 1,
    stdoutSha256: sha256Bytes('stdout'),
    stderrSha256: sha256Bytes('stderr'),
    failureCategory: passed ? ('none' as const) : ('exit_nonzero' as const),
  })
  return {
    ...result,
    status: 'completed',
    patch: { ...result.patch, present: true },
    output: {
      schemaVersion: 1,
      graderRevision: 'isolated-grader-v1',
      status: 'completed',
      inputSha256: result.inputSha256,
      caseId,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: 1,
      commands: [
        command('setup', 'verifier-start', true),
        command('public', 'regression', true, 'regression'),
        command('private', 'target-1', true, 'target-1'),
        command('private', 'target-2', false, 'target-2'),
      ],
    },
  }
}
