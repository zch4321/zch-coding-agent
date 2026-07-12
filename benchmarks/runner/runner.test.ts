import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type {
  HeadlessConfig,
  HeadlessResult,
} from '../../electron/headless/contracts'
import {
  loadNativeBenchmarkSuite,
  type NativeBenchmarkSuite,
} from '../adapters/native'
import type { LoadedBenchmarkCase, PrivateCaseSpec } from '../cases/contracts'
import { loadPrivateCaseSpec } from '../cases/loader'
import { runGit } from '../cases/process'
import type {
  DockerWorkerResult,
  DockerWorkerRunInput,
} from '../worker/contracts'
import type { DockerWorkerRunner } from './contracts'
import { createBenchmarkFeedback } from './feedback'
import { runBenchmarkTrials } from './runner'

const temporaryDirectories: string[] = []
let suite: NativeBenchmarkSuite
let loadedCase: LoadedBenchmarkCase
let privateSpec: PrivateCaseSpec

beforeAll(async () => {
  suite = await loadNativeBenchmarkSuite({
    benchmarkRoot: path.resolve('benchmarks'),
    suiteFile: 'manifests/core-24/suite.json',
  })
  loadedCase = suite.cases.find(
    (candidate) => candidate.manifest.id === 'slugify-normalization',
  )!
  privateSpec = await loadPrivateCaseSpec(loadedCase)
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('benchmark runner', () => {
  it('keeps strict evaluation hidden and preserves resolved_initial', async () => {
    const outputDirectory = await temporaryDirectory()
    let calls = 0
    const worker: DockerWorkerRunner = async (input) => {
      calls += 1
      expect(input.benchmarkControl).toBeUndefined()
      await applyPatch(input.workspaceDirectory, privateSpec.mutants[0]!.patch)
      return workerResult(input, 'strict-worker')
    }

    const run = await runBenchmarkTrials({
      ...baseInput(outputDirectory, worker),
      protocol: 'strict',
    })

    expect(calls).toBe(1)
    expect(run.trials[0]!.result.resolvedInitial).toBe(false)
    expect(run.trials[0]!.result.repairAttempted).toBe(false)
    expect(run.trials[0]!.result.afterFeedback).toBeUndefined()
  })

  it('repairs once in one worker and reports incremental and cumulative cost', async () => {
    const outputDirectory = await temporaryDirectory()
    let calls = 0
    let feedback = ''
    const sessionId = 'session-repair' as HeadlessResult['sessionId']
    const initialRunId = 'run-initial' as HeadlessResult['runIds'][number]
    const repairRunId = 'run-repair' as HeadlessResult['runIds'][number]
    const worker: DockerWorkerRunner = async (input) => {
      calls += 1
      await applyPatch(input.workspaceDirectory, privateSpec.mutants[0]!.patch)
      const decision = await input.benchmarkControl!.onPhaseReady({
        status: 'completed',
        sessionId,
        runIds: [initialRunId],
        usage: usage(10),
        tools: { proposed: 2, completed: 2, failed: 0 },
      })
      expect(decision.action).toBe('repair')
      if (decision.action === 'repair') feedback = decision.feedback.text
      await runGit({
        workspace: input.workspaceDirectory,
        args: ['reset', '--hard', 'HEAD'],
      })
      if (privateSpec.oracle.kind !== 'patch') throw new Error('patch expected')
      await applyPatch(input.workspaceDirectory, privateSpec.oracle.patch)
      await writeHeadlessResult(input, {
        sessionId,
        runIds: [initialRunId, repairRunId],
        usage: usage(16),
        tools: { proposed: 4, completed: 4, failed: 0 },
        benchmark: {
          protocol: 'repair-once',
          repairAttempted: true,
          initialRunIds: [initialRunId],
          repairRunIds: [repairRunId],
        },
      })
      return workerResult(input, 'repair-worker')
    }

    const run = await runBenchmarkTrials({
      ...baseInput(outputDirectory, worker),
      protocol: 'repair-once',
      feedbackVisibility: 'public',
    })
    const result = run.trials[0]!.result

    expect(calls).toBe(1)
    expect(feedback).toContain('Public checks: 1/1 passed')
    expect(feedback).not.toMatch(
      /oracle|hidden|edge-separators|unicode-folding/iu,
    )
    expect(result.sessionId).toBe('session-repair')
    expect(result.resolvedInitial).toBe(false)
    expect(result.resolvedAfterFeedback).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.afterFeedback?.incrementalMetrics?.usage.totalTokens).toBe(6)
    expect(result.afterFeedback?.cumulativeMetrics?.usage.totalTokens).toBe(16)
  })

  it('starts pass@k trials pristine and safely reuses only complete artifacts', async () => {
    const outputDirectory = await temporaryDirectory()
    const workspaces = new Set<string>()
    let calls = 0
    const worker: DockerWorkerRunner = async (input) => {
      calls += 1
      workspaces.add(input.workspaceDirectory)
      const status = await runGit({
        workspace: input.workspaceDirectory,
        args: ['status', '--porcelain'],
      })
      expect(status.stdout).toBe('')
      if (privateSpec.oracle.kind !== 'patch') throw new Error('patch expected')
      await applyPatch(input.workspaceDirectory, privateSpec.oracle.patch)
      return workerResult(input, `worker-${calls}`)
    }
    const request = {
      ...baseInput(outputDirectory, worker),
      protocol: 'strict' as const,
      trials: 2,
    }
    const first = await runBenchmarkTrials(request)
    await mkdir(path.join(outputDirectory, '.trial-0001.incomplete-abandoned'))
    const resumed = await runBenchmarkTrials(request)

    expect(calls).toBe(2)
    expect(workspaces.size).toBe(2)
    expect(first.trials.every((trial) => trial.result.resolvedInitial)).toBe(
      true,
    )
    expect(resumed.trials.every((trial) => trial.reused)).toBe(true)

    await writeFile(
      path.join(resumed.trials[0]!.directory, 'attempts/initial/patch.diff'),
      'tampered',
    )
    await expect(runBenchmarkTrials(request)).rejects.toThrow(
      'artifact checksum mismatch',
    )
  })

  it('rejects resume when the immutable trial identity changes', async () => {
    const outputDirectory = await temporaryDirectory()
    const worker: DockerWorkerRunner = async (input) =>
      workerResult(input, 'identity-worker')
    const request = baseInput(outputDirectory, worker)
    await runBenchmarkTrials(request)

    await expect(
      runBenchmarkTrials({
        ...request,
        config: { ...request.config, assistant: { language: 'zh-CN' } },
      }),
    ).rejects.toThrow('identity mismatch')
  })

  it('does not count a killed partial trial and starts its replacement pristine', async () => {
    const outputDirectory = await temporaryDirectory()
    const interrupted: DockerWorkerRunner = async (input) => {
      await applyPatch(input.workspaceDirectory, privateSpec.mutants[0]!.patch)
      throw new Error('simulated runner kill')
    }
    await expect(
      runBenchmarkTrials(baseInput(outputDirectory, interrupted)),
    ).rejects.toThrow('simulated runner kill')
    expect(
      (await readdir(outputDirectory)).some((name) =>
        name.includes('.incomplete-'),
      ),
    ).toBe(true)
    await expect(
      stat(path.join(outputDirectory, 'trial-0001')),
    ).rejects.toThrow()

    let pristine = false
    const replacement: DockerWorkerRunner = async (input) => {
      const status = await runGit({
        workspace: input.workspaceDirectory,
        args: ['status', '--porcelain'],
      })
      pristine = status.stdout === ''
      if (privateSpec.oracle.kind !== 'patch') throw new Error('patch expected')
      await applyPatch(input.workspaceDirectory, privateSpec.oracle.patch)
      return workerResult(input, 'replacement-worker')
    }
    const completed = await runBenchmarkTrials(
      baseInput(outputDirectory, replacement),
    )
    expect(pristine).toBe(true)
    expect(completed.trials[0]!.result.resolvedInitial).toBe(true)
  })

  it('rejects and removes artifacts containing the provider credential', async () => {
    const outputDirectory = await temporaryDirectory()
    const worker: DockerWorkerRunner = async (input) => {
      await writeFile(
        path.join(input.artifactsDirectory, 'leaky.log'),
        'ephemeral-secret',
      )
      return workerResult(input, 'leaky-worker')
    }
    await expect(
      runBenchmarkTrials(baseInput(outputDirectory, worker)),
    ).rejects.toThrow('credential leaked')
    expect(await readdir(outputDirectory)).toEqual([])
  })
})

describe('benchmark feedback', () => {
  it('limits diagnostic feedback to public group names and categories', () => {
    const feedback = createBenchmarkFeedback({
      visibility: 'diagnostic',
      evaluation: {
        schemaVersion: 1,
        status: 'graded',
        resolved: false,
        patchSha256: 'a'.repeat(64),
        failureCategory: 'acceptance_failed',
        publicChecks: [],
        groups: [
          {
            id: 'behavior',
            title: 'Published behavior group',
            critical: true,
            passed: false,
            publicPassed: true,
            privatePassed: false,
          },
        ],
      },
    })
    expect(feedback).toContain('Published behavior group')
    expect(feedback).toContain('acceptance failure')
    expect(feedback).not.toMatch(/private|hidden|oracle/iu)
  })
})

function baseInput(outputDirectory: string, workerRunner: DockerWorkerRunner) {
  return {
    loadedCase,
    suiteIdentitySha256: suite.suiteIdentitySha256,
    image: 'zch-agent-headless:test',
    config: config(),
    credential: { mode: 'direct' as const, credential: 'ephemeral-secret' },
    outputDirectory,
    workerRunner,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-runner-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function applyPatch(workspace: string, patch: string): Promise<void> {
  await runGit({
    workspace,
    args: ['apply', '--recount', '--whitespace=nowarn', '-'],
    stdin: patch,
  })
}

function workerResult(
  input: DockerWorkerRunInput,
  runId: string,
): DockerWorkerResult {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    runId,
    status: 'completed',
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    artifacts: {
      directory: input.artifactsDirectory,
      stdoutPath: path.join(input.artifactsDirectory, 'stdout.jsonl'),
      stderrPath: path.join(input.artifactsDirectory, 'stderr.log'),
      workerResultPath: path.join(
        input.artifactsDirectory,
        'worker-result.json',
      ),
    },
    cleanup: {
      agentRemoved: true,
      proxyRemoved: true,
      networkRemoved: true,
      secretsRemoved: true,
    },
  }
}

async function writeHeadlessResult(
  input: DockerWorkerRunInput,
  values: Pick<
    HeadlessResult,
    'sessionId' | 'runIds' | 'usage' | 'tools' | 'benchmark'
  >,
): Promise<void> {
  const now = new Date().toISOString()
  const result: HeadlessResult = {
    schemaVersion: 1,
    status: 'completed',
    sessionId: values.sessionId,
    runIds: values.runIds,
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    configHash: 'a'.repeat(64),
    autoPlanApprovals: 0,
    usage: values.usage,
    tools: values.tools,
    benchmark: values.benchmark,
    artifacts: {
      resultPath: '/artifacts/result.json',
      identityPath: '/artifacts/identity.json',
      tracePath: '/artifacts/trace.jsonl',
      patchStatus: 'written',
      patchPath: '/artifacts/patch.diff',
    },
  }
  await writeFile(
    path.join(input.artifactsDirectory, 'result.json'),
    JSON.stringify(result),
  )
}

function usage(totalTokens: number): HeadlessResult['usage'] {
  return {
    records: 1,
    promptTokens: totalTokens,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    cacheHitTokens: 0,
    cacheMissTokens: totalTokens,
  }
}

function config(): HeadlessConfig {
  return {
    schemaVersion: 1,
    provider: {
      id: 'benchmark-test',
      baseURL: 'http://provider.invalid/',
      model: 'fake-model',
      reasoning: 'off',
      credentialEnv: 'REWRITTEN_BY_WORKER',
    },
    assistant: { language: 'en-US' },
  }
}
