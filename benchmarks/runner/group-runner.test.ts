import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  loadNativeBenchmarkSuite,
  type NativeBenchmarkSuite,
} from '../adapters/native'
import type { BenchmarkTrialMetrics } from '../metrics/contracts'
import type {
  BenchmarkTrialsResult,
  RunBenchmarkTrialsInput,
} from './contracts'
import type {
  BenchmarkCaseTrialRunner,
  RunBenchmarkGroupInput,
} from './group-contracts'
import { runBenchmarkGroup } from './group-runner'

const temporaryDirectories: string[] = []
let suite: NativeBenchmarkSuite

beforeAll(async () => {
  suite = await loadNativeBenchmarkSuite({
    benchmarkRoot: path.resolve('benchmarks'),
    suiteFile: 'manifests/core-24/suite.json',
  })
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('benchmark run-group coordinator', () => {
  it('writes layered local artifacts and a redacted shareable summary', async () => {
    const outputDirectory = await temporaryDirectory()
    const runner = fakeTrialRunner()
    const result = await runBenchmarkGroup(
      groupInput(outputDirectory, runner, 2),
    )

    expect(result.summary).toMatchObject({
      status: 'completed',
      cases: 2,
      trials: 2,
      resolved: 1,
      metricsComplete: true,
      efficiency: {
        totalCostUsd: 10,
        costPerResolvedUsd: 10,
        unresolvedCostUsd: 9,
      },
    })
    await expect(
      stat(
        path.join(
          outputDirectory,
          'cases',
          'core-24',
          suite.cases[0]!.manifest.id,
          'trials',
          'trial-0001',
          'attempts',
          'initial',
          'patch.diff',
        ),
      ),
    ).resolves.toBeDefined()
    await expect(
      stat(path.join(outputDirectory, 'complete.json')),
    ).resolves.toBeDefined()

    const report = await readFile(
      path.join(outputDirectory, 'shareable-report.json'),
      'utf8',
    )
    expect(report).not.toContain('ephemeral-provider-secret')
    expect(report).not.toContain('raw-trace-private-content')
    expect(report).not.toContain('private-check-id')
    expect(report).not.toContain(outputDirectory)
    expect(report).toContain('benchmark-shareable-v1')
    expect(report).toContain('case-result.restricted.json')
    expect(report).toContain('conversation.restricted.md')
    expect(report).toContain('session-transcript.restricted.md')
  })

  it('resumes the same identity and rejects a different config', async () => {
    const outputDirectory = await temporaryDirectory()
    let calls = 0
    const runner = fakeTrialRunner(() => {
      calls += 1
      return calls > 1
    })
    const input = groupInput(outputDirectory, runner, 1)
    const first = await runBenchmarkGroup(input)
    const resumed = await runBenchmarkGroup(input)

    expect(first.identitySha256).toBe(resumed.identitySha256)
    expect(resumed.report.trials[0]?.reused).toBe(true)
    await expect(
      runBenchmarkGroup({
        ...input,
        config: { ...input.config, assistant: { language: 'zh-CN' } },
      }),
    ).rejects.toThrow('run-group identity mismatch')
  })

  it('marks a completed execution incomplete when trace metrics are absent', async () => {
    const outputDirectory = await temporaryDirectory()
    const result = await runBenchmarkGroup(
      groupInput(outputDirectory, fakeTrialRunner(undefined, false), 1),
    )

    expect(result.summary).toMatchObject({
      status: 'incomplete',
      missingMetricTrials: 1,
      metricsComplete: false,
    })
    expect(result.summary.efficiency).toBeUndefined()
  })
})

function groupInput(
  outputDirectory: string,
  trialRunner: BenchmarkCaseTrialRunner,
  caseCount: number,
): RunBenchmarkGroupInput {
  return {
    preset: 'smoke',
    selectedCases: suite.cases.slice(0, caseCount).map((loadedCase) => ({
      suite,
      loadedCase,
    })),
    image: 'zch-agent-headless:test',
    runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
    sourceCommit: 'b'.repeat(40),
    config: {
      schemaVersion: 1,
      provider: {
        id: 'provider',
        baseURL: 'https://provider.invalid/v1',
        model: 'model',
        reasoning: 'high',
        credentialEnv: 'PROVIDER_KEY',
      },
    },
    credential: {
      mode: 'proxy',
      upstreamCredential: 'ephemeral-provider-secret',
    },
    outputDirectory,
    trialsPerCase: 1,
    protocol: 'strict',
    trialRunner,
  }
}

function fakeTrialRunner(
  reused?: () => boolean,
  includeMetrics = true,
): BenchmarkCaseTrialRunner {
  return async (
    input: RunBenchmarkTrialsInput,
  ): Promise<BenchmarkTrialsResult> => {
    const trialDirectory = path.join(input.outputDirectory, 'trial-0001')
    const attemptDirectory = path.join(trialDirectory, 'attempts', 'initial')
    await mkdir(path.join(trialDirectory, 'worker'), { recursive: true })
    await mkdir(attemptDirectory, { recursive: true })
    await Promise.all([
      writeFile(
        path.join(attemptDirectory, 'patch.diff'),
        'diff --git a/a b/a\n',
      ),
      writeFile(
        path.join(trialDirectory, 'worker', 'trace.jsonl'),
        'raw-trace-private-content',
      ),
      writeFile(
        path.join(attemptDirectory, 'grader.restricted.json'),
        'private-check-id',
      ),
    ])
    const resolved =
      input.loadedCase.manifest.id === suite.cases[0]!.manifest.id
    const comparisonIdentity = {
      suiteIdentitySha256: input.suiteIdentitySha256,
      caseIdentitySha256: input.loadedCase.identity.manifestSha256,
      runtimeImageDigest: input.runtimeImageDigest!,
      caseImageDigest: input.loadedCase.manifest.caseImage.digest,
      graderImageDigest: input.runtimeImageDigest!,
      providerId: input.config.provider.id,
      model: input.config.provider.model,
      profile: input.config.provider.profile ?? 'generic',
      reasoning: input.config.provider.reasoning ?? 'high',
      budget: {
        ...input.loadedCase.manifest.resources,
      },
      protocol: input.protocol ?? 'strict',
      feedbackVisibility: input.feedbackVisibility ?? null,
      trialIndex: 1,
      priceSnapshotSha256: null,
    }
    const evaluation = {
      schemaVersion: 2 as const,
      status: 'graded' as const,
      resolved,
      level: resolved ? ('L5' as const) : ('L3' as const),
      groupMacroScore: resolved ? 1 : 0.5,
      patchSha256: 'c'.repeat(64),
      failureCategory: resolved
        ? ('none' as const)
        : ('acceptance_failed' as const),
      hardGates: [],
      publicChecks: [],
      groups: [],
      grader: {
        revision: 'grader',
        imageDigest: input.runtimeImageDigest!,
        inputSha256: 'd'.repeat(64),
      },
      ...(resolved
        ? {}
        : {
            error: {
              code: 'PRIVATE_FAILURE',
              message: `${input.outputDirectory}/private-check-id`,
            },
          }),
    }
    const metrics = includeMetrics
      ? trialMetrics(resolved ? 100 : 900, resolved ? 1 : 9)
      : undefined
    return {
      schemaVersion: 1,
      protocol: input.protocol ?? 'strict',
      trials: [
        {
          directory: trialDirectory,
          identity: {
            schemaVersion: 1,
            suiteId: input.loadedCase.manifest.suite.id,
            suiteRevision: input.loadedCase.manifest.suite.revision,
            suiteIdentitySha256: input.suiteIdentitySha256,
            caseId: input.loadedCase.manifest.id,
            caseIdentity: input.loadedCase.identity,
            runtimeImage: input.image,
            runtimeImageDigest: input.runtimeImageDigest!,
            graderRevision: 'grader',
            graderImageDigest: input.runtimeImageDigest!,
            expectedSourceCommit: input.expectedSourceCommit,
            headlessConfigSha256: 'e'.repeat(64),
            protocol: input.protocol ?? 'strict',
            feedbackVisibility: input.feedbackVisibility,
            trialIndex: 1,
            comparisonIdentity,
          },
          result: {
            schemaVersion: 1,
            identitySha256: 'f'.repeat(64),
            trialIndex: 1,
            protocol: input.protocol ?? 'strict',
            workerRunId: 'worker',
            workerStatus: 'completed',
            metrics,
            initial: { evaluation },
            repairAttempted: false,
            resolvedInitial: resolved,
            resolvedAfterFeedback: resolved,
            recovered: false,
            completedAt: '2026-01-01T00:00:01.000Z',
          },
          reused: reused?.() ?? false,
        },
      ],
    }
  }
}

function trialMetrics(tokens: number, cost: number): BenchmarkTrialMetrics {
  const usage = {
    records: 1,
    missingRecords: 0,
    promptTokens: tokens,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: tokens,
    cacheHitTokens: 0,
    cacheMissTokens: tokens,
  }
  return {
    schemaVersion: 1,
    usage: {
      byScope: {
        main: usage,
        approval: { ...usage, records: 0 },
        title: { ...usage, records: 0 },
        compression: { ...usage, records: 0 },
      },
      total: usage,
    },
    tools: {
      attempted: 1,
      proposed: 1,
      executed: 1,
      succeeded: 1,
      failed: 0,
      denied: 0,
      cancelled: 0,
      timedOut: 0,
      durationMs: 1,
      inputBytes: 1,
      outputBytes: 1,
      truncated: 0,
      duplicateArgumentSignatures: 0,
      byTool: {},
      byEffect: {},
      firstEffectiveEditMs: 1,
      firstTestMs: 2,
      idleAfterFinalVerificationMs: 0,
    },
    patch: {
      changedFiles: 1,
      addedLines: 1,
      deletedLines: 0,
      testFilesChanged: 0,
      binaryFilesChanged: 0,
      workspaceOutsideWriteAttempts: 0,
    },
    trajectory: {
      llmRequests: 1,
      continuations: 0,
      compactions: 0,
      planUpdates: 0,
      goalUpdates: 0,
      mcpDisclosures: 0,
      mcpCalls: 0,
      approvalRequests: 0,
      promptBuilds: 1,
      terminalEvents: 0,
    },
    cost: {
      currency: 'USD',
      priceSnapshotId: 'test',
      totalUsd: cost,
      byScope: { main: cost, approval: 0, title: 0, compression: 0 },
    },
    durationMs: 100,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-group-test-'))
  temporaryDirectories.push(directory)
  return directory
}
