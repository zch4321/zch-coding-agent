import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHeadlessConfig } from '../../electron/headless/config'
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
    })
    expect(packageJson.scripts.test).not.toContain('benchmark')
    expect(packageJson.scripts.build).not.toContain('benchmark')
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
