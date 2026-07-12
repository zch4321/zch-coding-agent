import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHeadlessConfig } from '../../electron/headless/config'
import type {
  ExternalBenchmarkCandidate,
  ExternalBenchmarkSource,
} from '../cohort/contracts'
import type {
  BenchmarkRunGroupResult,
  RunBenchmarkGroupInput,
} from '../runner/group-contracts'
import {
  BenchmarkCliError,
  parseBenchmarkArguments,
  runBenchmarkCli,
} from './cli'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('benchmark CLI', () => {
  it('ships a valid local config template without a credential value', async () => {
    const config = await loadHeadlessConfig(
      path.resolve('benchmark-config.example.json'),
    )

    expect(config.provider).toMatchObject({
      id: 'deepseek',
      model: 'deepseek-chat',
      credentialEnv: 'DEEPSEEK_API_KEY',
    })
    expect(JSON.stringify(config)).not.toMatch(/api[_-]?key\s*:/iu)
  })

  it('parses fixed presets, repeatable suites/cases, and safe defaults', () => {
    const args = parseBenchmarkArguments([
      'run',
      '--preset',
      'full',
      '--config',
      'benchmark-config.json',
      '--suite',
      'manifests/core-harness-8/suite.json',
      '--suite',
      'manifests/fresh-12/suite.json',
      '--case',
      'core-harness-8:case-a',
      '--case',
      'fresh-12:case-b',
      '--trials',
      '4',
    ])

    expect(args).toMatchObject({
      preset: 'full',
      suiteFiles: [
        'manifests/core-harness-8/suite.json',
        'manifests/fresh-12/suite.json',
      ],
      caseSelectors: ['core-harness-8:case-a', 'fresh-12:case-b'],
      trials: 4,
      protocol: 'strict',
      credentialMode: 'proxy',
      allowExternalNetwork: true,
    })
  })

  it('rejects ambiguous or unsafe argument combinations', () => {
    expect(() =>
      parseBenchmarkArguments([
        'run',
        '--preset',
        'smoke',
        '--config',
        'config.json',
        '--feedback',
        'diagnostic',
      ]),
    ).toThrow('--feedback requires repair-once')
    expect(() =>
      parseBenchmarkArguments([
        'run',
        '--preset',
        'smoke',
        '--config',
        'a.json',
        '--config',
        'b.json',
      ]),
    ).toThrow(BenchmarkCliError)
    expect(() =>
      parseBenchmarkArguments([
        'run',
        '--preset',
        'external',
        '--config',
        'config.json',
        '--cohort',
        'cohort.json',
        '--seed',
        'fixed',
      ]),
    ).toThrow('--cohort and --seed')
  })

  it('parses the external preset with a reproducible seed or pinned cohort', () => {
    const seeded = parseBenchmarkArguments([
      'run',
      '--preset',
      'external',
      '--config',
      'config.json',
      '--seed',
      'repeatable-seed',
    ])
    const pinned = parseBenchmarkArguments([
      'run',
      '--preset',
      'external',
      '--config',
      'config.json',
      '--cohort',
      'cohort.json',
    ])

    expect(seeded).toMatchObject({
      preset: 'external',
      seed: 'repeatable-seed',
    })
    expect(pinned.cohortFile).toBe(path.resolve('cohort.json'))
  })

  it('loads the real suite, keeps the key out of output, and applies smoke defaults', async () => {
    const directory = await temporaryDirectory()
    const configFile = path.join(directory, 'config.json')
    const outputDirectory = path.join(directory, 'results')
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        provider: {
          id: 'test-provider',
          baseURL: 'https://provider.invalid/v1',
          model: 'test-model',
          credentialEnv: 'BENCHMARK_PROVIDER_KEY',
        },
      }),
    )
    let received: RunBenchmarkGroupInput | undefined
    let stdout = ''
    let stderr = ''
    const result = await runBenchmarkCli(
      [
        'run',
        '--preset',
        'smoke',
        '--config',
        configFile,
        '--output',
        outputDirectory,
      ],
      {
        environment: {
          BENCHMARK_PROVIDER_KEY: 'super-secret-provider-key',
        },
        sourceCommit: 'a'.repeat(40),
        inspectImage: async (reference) => ({
          reference,
          digest: `sha256:${'b'.repeat(64)}`,
          sourceCommit: 'a'.repeat(40),
          sourceTree: 'clean',
          platform: 'linux/amd64',
          libc: 'glibc',
          nodeVersion: '24.0.0',
        }),
        groupRunner: async (input) => {
          received = input
          return fakeResult(outputDirectory)
        },
        output: stringWriter((value) => (stdout += value)),
        errorOutput: stringWriter((value) => (stderr += value)),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(received?.selectedCases).toHaveLength(3)
    expect(received?.trialsPerCase).toBe(1)
    expect(received?.credential).toEqual({
      mode: 'proxy',
      upstreamCredential: 'super-secret-provider-key',
      allowExternalNetwork: true,
    })
    expect((JSON.parse(stdout) as { directory: string }).directory).toBe(
      outputDirectory,
    )
    expect(stdout).not.toContain('super-secret-provider-key')

    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(packageJson.scripts).toMatchObject({
      'benchmark:smoke': expect.stringContaining('--preset smoke'),
      benchmark: expect.stringContaining('--preset daily'),
      'benchmark:full': expect.stringContaining('--preset full'),
      'benchmark:external': expect.stringContaining('--preset external'),
    })
    expect(packageJson.scripts.test).not.toContain('benchmark')
    expect(packageJson.scripts.build).not.toContain('benchmark')
  })

  it('writes and forwards an immutable rolling 8+8 cohort for the external preset', async () => {
    const directory = await temporaryDirectory()
    const configFile = path.join(directory, 'config.json')
    const outputDirectory = path.join(directory, 'external-results')
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        provider: {
          id: 'test-provider',
          baseURL: 'https://provider.invalid/v1',
          model: 'test-model',
          credentialEnv: 'BENCHMARK_PROVIDER_KEY',
        },
      }),
    )
    const candidates = externalCandidates()
    let received: RunBenchmarkGroupInput | undefined
    const result = await runBenchmarkCli(
      [
        'run',
        '--preset',
        'external',
        '--config',
        configFile,
        '--output',
        outputDirectory,
        '--seed',
        'cli-fixture',
      ],
      {
        environment: { BENCHMARK_PROVIDER_KEY: 'secret' },
        sourceCommit: 'a'.repeat(40),
        inspectImage: async (reference) => ({
          reference,
          digest: `sha256:${'b'.repeat(64)}`,
          sourceCommit: 'a'.repeat(40),
          sourceTree: 'clean',
          platform: 'linux/amd64',
          libc: 'glibc',
          nodeVersion: '24.0.0',
        }),
        loadExternalCatalogs: async () => [
          {
            release: externalRelease('monthly-swebench'),
            candidates: candidates.filter(
              (candidate) => candidate.source === 'monthly-swebench',
            ),
            exclusions: [],
          },
          {
            release: externalRelease('swe-rebench'),
            candidates: candidates.filter(
              (candidate) => candidate.source === 'swe-rebench',
            ),
            exclusions: [],
          },
        ],
        createExternalRuntime: () => ({
          resolveImage: async (candidate) => ({
            eligible: true,
            officialReference: candidate.officialImageReference,
            officialDigest: `sha256:${'c'.repeat(64)}`,
            agentImageDigest: `sha256:${'d'.repeat(64)}`,
          }),
          prepare: async ({ destination }) => ({
            directory: destination,
            mount: {
              kind: 'volume',
              name: 'fixture-volume',
              containerPath: '/testbed',
            },
          }),
          capturePatch: async () => '',
          grade: async () => {
            throw new Error('not run by the CLI fixture')
          },
          dispose: async () => undefined,
        }),
        groupRunner: async (input) => {
          received = input
          return fakeResult(outputDirectory)
        },
        output: stringWriter(() => undefined),
        errorOutput: stringWriter(() => undefined),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(received?.selectedCases).toHaveLength(16)
    expect(received?.trialsPerCase).toBe(3)
    expect(received?.cohortHash).toMatch(/^[a-f0-9]{64}$/u)
    const cohort = JSON.parse(
      await readFile(path.join(outputDirectory, 'cohort.json'), 'utf8'),
    ) as { seed: string; cases: unknown[]; cohortHash: string }
    expect(cohort).toMatchObject({
      seed: 'cli-fixture',
      cohortHash: received?.cohortHash,
    })
    expect(cohort.cases).toHaveLength(16)
  })
})

function fakeResult(directory: string): BenchmarkRunGroupResult {
  const summary = {
    schemaVersion: 1 as const,
    identitySha256: 'c'.repeat(64),
    preset: 'smoke' as const,
    status: 'completed' as const,
    cases: 3,
    trials: 3,
    resolved: 1,
    resolvedInitial: 1,
    recovered: 0,
    metricsComplete: true,
    missingMetricTrials: 0,
    levels: { L0: 0, L1: 0, L2: 0, L3: 2, L4: 0, L5: 1 },
    failureCategories: { none: 1, acceptance_failed: 2 },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
  }
  return {
    directory,
    identity: {
      schemaVersion: 1,
      preset: 'smoke',
      suites: [],
      cases: [],
      image: 'image',
      runtimeImageDigest: `sha256:${'b'.repeat(64)}`,
      sourceCommit: 'a'.repeat(40),
      configSha256: 'd'.repeat(64),
      provider: {
        id: 'provider',
        model: 'model',
        profile: 'generic',
        reasoning: 'high',
      },
      protocol: 'strict',
      feedbackVisibility: null,
      trialsPerCase: 1,
      priceSnapshotSha256: null,
    },
    identitySha256: summary.identitySha256,
    summary,
    report: {
      schemaVersion: 1,
      identitySha256: summary.identitySha256,
      preset: 'smoke',
      summary,
      trials: [],
      redaction: {
        policy: 'benchmark-shareable-v1',
        restrictedArtifacts: [],
        removedFields: [],
      },
    },
    cases: [],
  }
}

function stringWriter(onWrite: (value: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      onWrite(String(chunk))
      callback()
    },
  })
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-cli-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function externalCandidates(): ExternalBenchmarkCandidate[] {
  const monthly = Array.from({ length: 8 }, (_, index) =>
    externalCandidate(
      'monthly-swebench',
      index,
      index < 4 ? 'bug-fix' : 'non-bug',
    ),
  )
  const rebench = Array.from({ length: 8 }, (_, index) =>
    externalCandidate('swe-rebench', index, 'bug-fix'),
  )
  return [...monthly, ...rebench]
}

function externalCandidate(
  source: ExternalBenchmarkSource,
  index: number,
  classification: 'bug-fix' | 'non-bug',
): ExternalBenchmarkCandidate {
  const common = {
    ...externalRelease(source),
    caseId: `${source}-case-${index}`,
    repository: `${source}/repo-${index}`,
    classification,
    language: index % 2 ? 'python' : 'go',
    problemStatement: `External task ${index}`,
    baseCommit: 'e'.repeat(40),
    patchBytes: 500 + index * 3_000,
    officialImageReference: `fixture/${source}-${index}:latest`,
  }
  return source === 'monthly-swebench'
    ? {
        ...common,
        privatePayload: {
          kind: 'monthly-swebench',
          archiveFile:
            classification === 'bug-fix'
              ? 'bugfix.tar.zst'
              : 'non_bugfix.tar.zst',
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
          solutionPatch: 'gold',
          testPatch: 'tests',
          failToPass: ['target'],
          passToPass: [],
          verifier: {},
        },
      }
}

function externalRelease(source: ExternalBenchmarkSource) {
  return {
    source,
    dataset: `fixture/${source}`,
    release: '2026-05',
    commit: 'f'.repeat(40),
    adapterRevision: `${source}-v1`,
  }
}
