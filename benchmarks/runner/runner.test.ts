import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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
import { runTrustedNativeTestGrader } from '../grader/native-test-adapter'
import type {
  DockerWorkerResult,
  DockerWorkerRunInput,
} from '../worker/contracts'
import type { DockerWorkerRunner } from './contracts'
import { createBenchmarkFeedback } from './feedback'
import { runBenchmarkTrials, scanArtifactsForCredential } from './runner'

const temporaryDirectories: string[] = []
let suite: NativeBenchmarkSuite
let loadedCase: LoadedBenchmarkCase
let privateSpec: PrivateCaseSpec

beforeAll(async () => {
  suite = await loadNativeBenchmarkSuite({
    benchmarkRoot: path.resolve('benchmarks'),
    suiteFile: 'manifests/core-harness-8/suite.json',
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

describe('benchmark runner', { timeout: 15_000 }, () => {
  it('keeps strict evaluation hidden and preserves resolved_initial', async () => {
    const outputDirectory = await temporaryDirectory()
    let calls = 0
    const progress: string[] = []
    const worker: DockerWorkerRunner = async (input) => {
      calls += 1
      expect(input.benchmarkControl).toBeUndefined()
      expect(input.benchmarkCase?.modificationScope).toMatchObject({
        allowedPaths: ['src/**'],
        deniedPaths: ['test/**', 'package.json'],
      })
      await applyPatch(input.workspaceDirectory, privateSpec.mutants[0]!.patch)
      return workerResult(input, 'strict-worker')
    }

    const run = await runBenchmarkTrials({
      ...baseInput(outputDirectory, worker),
      protocol: 'strict',
      onProgress: (event) => progress.push(event.phase),
    })

    expect(calls).toBe(1)
    expect(run.trials[0]!.result.resolvedInitial).toBe(false)
    expect(run.trials[0]!.result.repairAttempted).toBe(false)
    expect(run.trials[0]!.result.afterFeedback).toBeUndefined()
    expect(progress).toEqual(['trial-start', 'trial-complete'])
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
  }, 15_000)

  it('does not turn grader infrastructure failure into model feedback', async () => {
    const outputDirectory = await temporaryDirectory()
    let decisionAction = ''
    const worker: DockerWorkerRunner = async (input) => {
      const decision = await input.benchmarkControl!.onPhaseReady({
        status: 'completed',
        sessionId: 'grader-failure' as HeadlessResult['sessionId'],
        runIds: ['grader-failure-run' as HeadlessResult['runIds'][number]],
        usage: usage(1),
        tools: { proposed: 0, completed: 0, failed: 0 },
      })
      decisionAction = decision.action
      return workerResult(input, 'grader-failure-worker')
    }
    const request = baseInput(outputDirectory, worker)
    const run = await runBenchmarkTrials({
      ...request,
      protocol: 'repair-once',
      graderRunner: async () => {
        throw new Error('simulated grader crash')
      },
    })

    expect(decisionAction).toBe('finish')
    expect(run.trials[0]!.result.repairAttempted).toBe(false)
    expect(run.trials[0]!.result.initial.evaluation.status).toBe('invalid')
    expect(run.trials[0]!.result.initial.evaluation.resolved).toBe(false)
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

  it('persists trace-derived metrics with a fixed price snapshot', async () => {
    const outputDirectory = await temporaryDirectory()
    const worker: DockerWorkerRunner = async (input) => {
      if (privateSpec.oracle.kind !== 'patch') throw new Error('patch expected')
      await applyPatch(input.workspaceDirectory, privateSpec.oracle.patch)
      await writeHeadlessResult(input, {
        sessionId: 'metrics-session' as HeadlessResult['sessionId'],
        runIds: ['metrics-run' as HeadlessResult['runIds'][number]],
        usage: usage(12),
        tools: { proposed: 0, completed: 0, failed: 0 },
        benchmark: undefined,
      })
      const traceDirectory = path.join(
        input.artifactsDirectory,
        'runtime',
        'traces',
      )
      await mkdir(traceDirectory, { recursive: true })
      await writeFile(
        path.join(traceDirectory, 'metrics-session.jsonl'),
        `${[
          {
            schemaVersion: 1,
            seq: 1,
            eventId: 'event-1',
            ts: '2026-01-01T00:00:00.000Z',
            type: 'session.start',
            sessionId: 'metrics-session',
            workspace: '/workspace',
            model: 'fake-model',
            mode: 'yolo',
          },
          {
            schemaVersion: 1,
            seq: 2,
            eventId: 'event-2',
            ts: '2026-01-01T00:00:00.001Z',
            type: 'orchestrator.message',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            kind: 'benchmark_case',
            text: '{"allowedPaths":["src/**"]}',
          },
          {
            schemaVersion: 1,
            seq: 3,
            eventId: 'event-3',
            ts: '2026-01-01T00:00:00.002Z',
            type: 'user.message',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            text: 'Fix the benchmark case',
          },
          {
            schemaVersion: 1,
            seq: 4,
            eventId: 'event-4',
            ts: '2026-01-01T00:00:00.003Z',
            type: 'llm.request',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            callId: 'metrics-call',
            scope: 'main',
            normalizedMessages: [],
            providerRequest: {},
            requestBytes: 10,
            prefixHash: 'prefix',
            promptBuild: {
              schemaVersion: 1,
              layers: [],
              messageCount: 0,
              historyMessageCount: 0,
              ledgerMessageCount: 0,
              omittedHistoryMessages: 0,
              promptBudgetTokens: 1_000,
              estimatedTokens: 1,
              toolsHash: 'f'.repeat(64),
            },
          },
          {
            schemaVersion: 1,
            seq: 5,
            eventId: 'event-5',
            ts: '2026-01-01T00:00:00.010Z',
            type: 'llm.usage',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            callId: 'metrics-call',
            usage: {
              scope: 'main',
              providerId: 'benchmark-test',
              providerLabel: 'Benchmark test',
              model: 'fake-model',
              promptTokens: 10,
              completionTokens: 2,
              totalTokens: 12,
              reasoningTokens: 0,
              cacheHitTokens: 0,
              cacheMissTokens: 10,
              contextWindowTokens: 10_000,
              contextWindowSource: 'builtin',
              raw: {},
            },
          },
          {
            schemaVersion: 1,
            seq: 6,
            eventId: 'event-6',
            ts: '2026-01-01T00:00:00.011Z',
            type: 'tool.call',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            callId: 'metrics-tool-call',
            tool: 'run_command',
            args: {
              mode: 'process',
              executable: 'node',
              args: ['test/public.test.mjs'],
            },
            result: { status: 'ok', content: '' },
            approvedBy: 'yolo',
            policySignals: [],
            durationMs: 1,
          },
          {
            schemaVersion: 1,
            seq: 7,
            eventId: 'event-7',
            ts: '2026-01-01T00:00:00.012Z',
            type: 'agent.message',
            sessionId: 'metrics-session',
            runId: 'metrics-run',
            text: 'Implemented the fix.',
          },
          {
            schemaVersion: 1,
            seq: 8,
            eventId: 'event-8',
            ts: '2026-01-01T00:00:00.013Z',
            type: 'session.end',
            sessionId: 'metrics-session',
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
      )
      return workerResult(input, 'metrics-worker')
    }
    const run = await runBenchmarkTrials({
      ...baseInput(outputDirectory, worker),
      priceSnapshot: {
        schemaVersion: 1,
        id: 'test-price-v1',
        source: 'runner test',
        revision: '1',
        currency: 'USD',
        providerId: 'benchmark-test',
        model: 'fake-model',
        ratesPerMillionTokens: {
          promptTokens: 1,
          completionTokens: 2,
        },
      },
    })
    const trial = run.trials[0]!

    expect(trial.identity.comparisonIdentity.providerId).toBe('benchmark-test')
    expect(trial.identity.priceSnapshotSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(trial.result.metrics?.usage.total.totalTokens).toBe(12)
    expect(trial.result.metrics?.cost.totalUsd).toBeCloseTo(0.000014)
    await expect(
      stat(path.join(trial.directory, 'metrics.json')),
    ).resolves.toBeDefined()
    const conversation = await readFile(
      path.join(trial.directory, 'conversation.restricted.md'),
      'utf8',
    )
    expect(conversation).toContain('## orchestrator')
    expect(conversation).toContain('Fix the benchmark case')
    expect(conversation).toContain('Implemented the fix.')
    expect(trial.result.artifacts?.conversationMarkdown).toBe(
      'conversation.restricted.md',
    )
    const transcript = await readFile(
      path.join(trial.directory, 'session-transcript.restricted.md'),
      'utf8',
    )
    expect(transcript).toContain('zch-session-transcript')
    expect(transcript).toContain('run_command')
    expect(transcript).toContain('benchmark_case')
    expect(trial.result.artifacts?.sessionTranscript).toBe(
      'session-transcript.restricted.md',
    )
  })

  it('exempts only the restricted session transcript from credential scanning', async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      path.join(directory, 'session-transcript.restricted.md'),
      'local-secret',
      'utf8',
    )
    await writeFile(path.join(directory, 'safe.json'), '{}', 'utf8')
    await expect(
      scanArtifactsForCredential({
        directory,
        credential: 'local-secret',
        excludedFiles: new Set(['session-transcript.restricted.md']),
      }),
    ).resolves.toMatchObject({ filesScanned: 1, sensitiveMatches: 0 })
    await writeFile(path.join(directory, 'unsafe.log'), 'local-secret', 'utf8')
    await expect(
      scanArtifactsForCredential({
        directory,
        credential: 'local-secret',
        excludedFiles: new Set(['session-transcript.restricted.md']),
      }),
    ).rejects.toThrow('unsafe.log')
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

  it('does not resolve an L5 patch when worker cleanup evidence fails', async () => {
    const outputDirectory = await temporaryDirectory()
    const worker: DockerWorkerRunner = async (input) => {
      if (privateSpec.oracle.kind !== 'patch') throw new Error('patch expected')
      await applyPatch(input.workspaceDirectory, privateSpec.oracle.patch)
      const result = workerResult(input, 'cleanup-failure-worker')
      result.cleanup.networkRemoved = false
      return result
    }
    const run = await runBenchmarkTrials(baseInput(outputDirectory, worker))
    const evaluation = run.trials[0]!.result.initial.evaluation

    expect(evaluation.level).toBe('L5')
    expect(evaluation.status).toBe('invalid')
    expect(evaluation.resolved).toBe(false)
    expect(
      evaluation.hardGates.find((gate) => gate.id === 'worker_cleanup')?.passed,
    ).toBe(false)
  })

  it('preserves worker unsupported status without launching a grader', async () => {
    const outputDirectory = await temporaryDirectory()
    let graderCalls = 0
    const worker: DockerWorkerRunner = async (input) => {
      const result = workerResult(input, 'unsupported-worker')
      result.status = 'unsupported'
      return result
    }
    const request = baseInput(outputDirectory, worker)
    const run = await runBenchmarkTrials({
      ...request,
      graderRunner: async (input) => {
        graderCalls += 1
        return await runTrustedNativeTestGrader(input)
      },
    })

    expect(graderCalls).toBe(0)
    expect(run.trials[0]!.result.initial.evaluation.status).toBe('unsupported')
    expect(run.trials[0]!.result.initial.evaluation.failureCategory).toBe(
      'unsupported',
    )
  })
})

describe('benchmark feedback', () => {
  it('limits diagnostic feedback to public group names and categories', () => {
    const feedback = createBenchmarkFeedback({
      visibility: 'diagnostic',
      evaluation: {
        schemaVersion: 2,
        status: 'graded',
        resolved: false,
        level: 'L4',
        groupMacroScore: 0,
        patchSha256: 'a'.repeat(64),
        failureCategory: 'acceptance_failed',
        hardGates: [],
        publicChecks: [],
        groups: [
          {
            id: 'behavior',
            title: 'Published behavior group',
            critical: true,
            passed: false,
            publicPassed: true,
            privatePassed: false,
            weight: 1,
            evidence: {
              public: { passed: 0, total: 0, failureCategories: [] },
              private: {
                passed: 0,
                total: 1,
                failureCategories: ['exit_nonzero'],
              },
            },
          },
        ],
        grader: {
          revision: 'isolated-grader-v1',
          imageDigest: 'sha256:test',
          inputSha256: 'b'.repeat(64),
        },
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
    adapter: suite.caseAdapter,
    suiteIdentitySha256: suite.suiteIdentitySha256,
    image: 'zch-agent-headless:test',
    config: config(),
    credential: { mode: 'direct' as const, credential: 'ephemeral-secret' },
    outputDirectory,
    workerRunner,
    graderRunner: runTrustedNativeTestGrader,
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
