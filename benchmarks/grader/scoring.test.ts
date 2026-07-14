import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  loadNativeBenchmarkSuite,
  type NativeBenchmarkSuite,
} from '../adapters/native'
import type { LoadedBenchmarkCase } from '../cases/contracts'
import { sha256Bytes } from '../cases/hash'
import type { BenchmarkHardGate } from '../runner/contracts'
import {
  ISOLATED_GRADER_REVISION,
  type GraderCommandOutcome,
  type IsolatedGraderRunResult,
} from './contracts'
import { scoreIsolatedGrader } from './scoring'

let suite: NativeBenchmarkSuite
let loadedCase: LoadedBenchmarkCase

beforeAll(async () => {
  suite = await loadNativeBenchmarkSuite({
    benchmarkRoot: path.resolve('benchmarks'),
    suiteFile: 'manifests/core-harness-8/suite.json',
  })
  loadedCase = suite.cases.find(
    (candidate) => candidate.manifest.id === 'slugify-normalization',
  )!
})

describe('isolated grader scoring', () => {
  it.each([
    {
      name: 'no change',
      patch: false,
      setup: true,
      public: true,
      private: true,
      level: 'L0',
    },
    {
      name: 'build failure',
      patch: true,
      setup: false,
      public: false,
      private: false,
      level: 'L1',
    },
    {
      name: 'build only',
      patch: true,
      setup: true,
      public: false,
      private: false,
      level: 'L2',
    },
    {
      name: 'regression only',
      patch: true,
      setup: true,
      public: true,
      private: false,
      forceCorePrivateFailure: true,
      level: 'L3',
    },
    {
      name: 'partial behavior',
      patch: true,
      setup: true,
      public: true,
      private: false,
      level: 'L4',
    },
    {
      name: 'complete behavior',
      patch: true,
      setup: true,
      public: true,
      private: true,
      level: 'L5',
    },
  ] as const)('assigns $level to $name', (scenario) => {
    const grader = graderRun({
      patch: scenario.patch,
      setup: scenario.setup,
      public: scenario.public,
      private: scenario.private,
      forceCorePrivateFailure: scenario.forceCorePrivateFailure ?? false,
    })
    const result = scoreIsolatedGrader({ loadedCase, grader })

    expect(result.status).toBe('graded')
    expect(result.level).toBe(scenario.level)
    expect(result.resolved).toBe(scenario.level === 'L5')
  })

  it('macro-averages behavior groups instead of individual checks', () => {
    const grader = graderRun({
      patch: true,
      setup: true,
      public: true,
      private: false,
    })
    const baseline = scoreIsolatedGrader({ loadedCase, grader })
    grader.output!.commands.push(
      ...Array.from({ length: 10 }, (_, index) =>
        outcome('private', `duplicate-${index}`, 'core-behavior', true),
      ),
    )
    const duplicated = scoreIsolatedGrader({ loadedCase, grader })

    expect(baseline.groupMacroScore).toBe(1 / 3)
    expect(duplicated.groupMacroScore).toBe(1 / 3)
  })

  it('separates unsupported, infrastructure invalid, and agent hard-gate failures', () => {
    const unsupported = graderRun({
      patch: true,
      setup: true,
      public: true,
      private: true,
    })
    unsupported.status = 'unsupported'
    const invalid = graderRun({
      patch: true,
      setup: true,
      public: true,
      private: true,
    })
    invalid.sandbox.networkDisabled = false
    const attempted = graderRun({
      patch: true,
      setup: true,
      public: true,
      private: true,
    })
    attempted.status = 'attempted'
    attempted.patch.scopeCompliant = false
    attempted.output = undefined

    expect(
      scoreIsolatedGrader({ loadedCase, grader: unsupported }).status,
    ).toBe('unsupported')
    expect(scoreIsolatedGrader({ loadedCase, grader: invalid }).status).toBe(
      'invalid',
    )
    const attemptedResult = scoreIsolatedGrader({
      loadedCase,
      grader: attempted,
    })
    expect(attemptedResult.status).toBe('attempted')
    expect(attemptedResult.failureCategory).toBe('scope_violation')
  })

  it('refuses resolved when a post-grader infrastructure gate fails', () => {
    const additionalGates: BenchmarkHardGate[] = [
      { id: 'worker_cleanup', passed: false, owner: 'infrastructure' },
    ]
    const result = scoreIsolatedGrader({
      loadedCase,
      grader: graderRun({
        patch: true,
        setup: true,
        public: true,
        private: true,
      }),
      additionalGates,
    })

    expect(result.level).toBe('L5')
    expect(result.status).toBe('invalid')
    expect(result.resolved).toBe(false)
  })
})

function graderRun(input: {
  patch: boolean
  setup: boolean
  public: boolean
  private: boolean
  forceCorePrivateFailure?: boolean
}): IsolatedGraderRunResult {
  const now = new Date().toISOString()
  const commands: GraderCommandOutcome[] = [
    outcome('setup', 'setup-1', undefined, input.setup),
    outcome('public', 'public-slug', 'core-behavior', input.public),
    ...(input.forceCorePrivateFailure
      ? [outcome('private', 'private-core', 'core-behavior', false)]
      : []),
    outcome('private', 'edge', 'edge-separators', input.private),
    outcome('private', 'unicode', 'unicode-folding', input.private),
  ]
  return {
    schemaVersion: 1,
    status: 'completed',
    graderRevision: ISOLATED_GRADER_REVISION,
    graderImageDigest: 'sha256:grader-test',
    inputSha256: sha256Bytes('grader-input'),
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    patch: {
      sha256: sha256Bytes(input.patch ? 'patch' : ''),
      present: input.patch,
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
    output: {
      schemaVersion: 1,
      graderRevision: ISOLATED_GRADER_REVISION,
      status: 'completed',
      inputSha256: sha256Bytes('grader-input'),
      caseId: loadedCase.manifest.id,
      startedAt: now,
      completedAt: now,
      durationMs: 1,
      commands,
    },
    cleanup: { containerRemoved: true, privateDirectoryRemoved: true },
    artifacts: {
      directory: 'test-artifacts',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      coordinatorResultPath: 'coordinator-result.restricted.json',
    },
  }
}

function outcome(
  stage: GraderCommandOutcome['stage'],
  id: string,
  acceptanceGroupId: string | undefined,
  passed: boolean,
): GraderCommandOutcome {
  return {
    stage,
    id,
    acceptanceGroupId,
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: 1,
    stdoutSha256: sha256Bytes(''),
    stderrSha256: sha256Bytes(''),
    failureCategory: passed ? 'none' : 'exit_nonzero',
  }
}
