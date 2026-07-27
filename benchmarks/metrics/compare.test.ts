import { describe, expect, it } from 'vitest'
import {
  BenchmarkComparisonIdentityError,
  compareBenchmarkRunGroups,
  summarizeBenchmarkRunGroup,
} from './compare'
import type {
  BenchmarkComparableTrial,
  BenchmarkComparisonIdentity,
  BenchmarkTrialMetrics,
} from './contracts'

describe('benchmark run group comparison', () => {
  it('charges every trial to cost_per_resolved and reports paired deltas', () => {
    const baseline = [
      trial('case-a', 1, true, metrics(100, 1, 3, 1_000)),
      trial('case-b', 1, false, metrics(900, 9, 7, 2_000)),
    ]
    const candidate = [
      trial('case-a', 1, true, metrics(80, 0.8, 2, 900)),
      trial('case-b', 1, true, metrics(700, 7, 5, 1_800)),
    ]

    const summary = summarizeBenchmarkRunGroup(baseline)
    expect(summary.totalCostUsd).toBe(10)
    expect(summary.costPerResolvedUsd).toBe(10)
    expect(summary.unresolvedCostUsd).toBe(9)

    const report = compareBenchmarkRunGroups({ baseline, candidate })
    expect(report.resolveDelta).toBe(0.5)
    expect(report.paired.map((pair) => pair.resolveDelta)).toEqual([0, 1])
    expect(report.pairedOutcomes).toEqual({ wins: 1, losses: 0, ties: 1 })
    expect(report.ordering).toBe('candidate')
  })

  it('rejects non-identical pairs and names every mismatched field', () => {
    const baseline = [trial('case-a', 1, true, metrics(1, 1, 1, 1))]
    const changed = trial('case-a', 1, true, metrics(1, 1, 1, 1))
    changed.identity = {
      ...changed.identity,
      providerId: 'other-provider',
      budget: { ...changed.identity.budget, maxAgentSteps: 99 },
    }

    expect(() =>
      compareBenchmarkRunGroups({ baseline, candidate: [changed] }),
    ).toThrow(BenchmarkComparisonIdentityError)
    try {
      compareBenchmarkRunGroups({ baseline, candidate: [changed] })
    } catch (error) {
      expect(error).toBeInstanceOf(BenchmarkComparisonIdentityError)
      expect((error as BenchmarkComparisonIdentityError).mismatches).toEqual(
        expect.arrayContaining([
          expect.stringContaining('identity.providerId'),
          expect.stringContaining('identity.budget.maxAgentSteps'),
        ]),
      )
    }
  })
})

function trial(
  caseId: string,
  trialIndex: number,
  resolved: boolean,
  metrics: BenchmarkTrialMetrics,
): BenchmarkComparableTrial {
  return {
    caseId,
    identity: identity(caseId, trialIndex),
    resolved,
    level: resolved ? 'L5' : 'L3',
    groupMacroScore: resolved ? 1 : 0.5,
    hardGatesPassed: true,
    metrics,
  }
}

function identity(
  caseId: string,
  trialIndex: number,
): BenchmarkComparisonIdentity {
  return {
    suiteIdentitySha256: 'a'.repeat(64),
    caseIdentitySha256: caseId.padEnd(64, '0'),
    runtimeImageDigest: `sha256:${'b'.repeat(64)}`,
    caseImageDigest: `sha256:${'c'.repeat(64)}`,
    graderImageDigest: `sha256:${'d'.repeat(64)}`,
    providerId: 'provider',
    model: 'model',
    providerType: 'generic.chat-completions',
    reasoning: 'high',
    budget: {
      wallTimeMs: 1_000,
      cpus: 1,
      memoryBytes: 1,
      pids: 1,
      diskBytes: 1,
      maxAgentSteps: 10,
      maxContextTokens: 10_000,
    },
    protocol: 'strict',
    feedbackVisibility: null,
    trialIndex,
    priceSnapshotSha256: 'e'.repeat(64),
  }
}

function metrics(
  tokens: number,
  cost: number,
  tools: number,
  durationMs: number,
): BenchmarkTrialMetrics {
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
  const toolBucket = {
    attempted: tools,
    proposed: tools,
    executed: tools,
    succeeded: tools,
    failed: 0,
    denied: 0,
    cancelled: 0,
    timedOut: 0,
    durationMs: 0,
    inputBytes: 0,
    outputBytes: 0,
    truncated: 0,
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
      ...toolBucket,
      duplicateArgumentSignatures: 0,
      byTool: {},
      byEffect: {},
      firstEffectiveEditMs: null,
      firstTestMs: null,
      idleAfterFinalVerificationMs: null,
    },
    patch: {
      changedFiles: 0,
      addedLines: 0,
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
      priceSnapshotId: 'price',
      totalUsd: cost,
      byScope: { main: cost, approval: 0, title: 0, compression: 0 },
    },
    durationMs,
  }
}
