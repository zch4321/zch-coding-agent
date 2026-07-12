import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../electron/logging/events'
import { aggregateBenchmarkMetrics } from './aggregate'
import type { BenchmarkPriceSnapshot } from './contracts'

describe('benchmark metric aggregation', () => {
  it('counts validation, permission, execution failure, and success separately', () => {
    const trace: TraceEvent[] = [
      event('session.start', 1, 0, {
        workspace: '/workspace',
        model: 'model',
        mode: 'yolo',
      }),
      attempt(2, 100, 'invalid', 'apply_patch', 'validation', 'rejected', {
        effects: ['filesystem.write'],
        errorCode: 'INVALID_TOOL_ARGS',
      }),
      call(3, 100, 'invalid', 'apply_patch', { patch: 'bad' }, 'error'),
      attempt(4, 200, 'denied', 'delete_file', 'permission', 'denied', {
        effects: ['filesystem.delete'],
      }),
      call(5, 200, 'denied', 'delete_file', { path: 'a.ts' }, 'denied'),
      attempt(6, 300, 'failed', 'apply_patch', 'execution', 'failed', {
        effects: ['filesystem.write'],
        errorCode: 'PATCH_FAILED',
      }),
      call(7, 300, 'failed', 'apply_patch', { patch: 'same' }, 'error'),
      attempt(8, 400, 'success', 'run_command', 'execution', 'succeeded', {
        effects: ['process.spawn'],
      }),
      call(
        9,
        400,
        'success',
        'run_command',
        {
          mode: 'process',
          executable: 'node',
          args: ['test/public.test.mjs'],
        },
        'ok',
      ),
      attempt(10, 500, 'duplicate', 'run_command', 'execution', 'failed', {
        effects: ['process.spawn'],
      }),
      call(
        11,
        500,
        'duplicate',
        'run_command',
        {
          args: ['test/public.test.mjs'],
          executable: 'node',
          mode: 'process',
        },
        'error',
      ),
    ]
    const metrics = aggregateBenchmarkMetrics({
      trace,
      patch: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1,2 @@',
        '-old',
        '+new',
        '+line',
        'diff --git a/tests/a.test.ts b/tests/a.test.ts',
        '--- a/tests/a.test.ts',
        '+++ b/tests/a.test.ts',
        '@@ -0,0 +1 @@',
        '+test',
      ].join('\n'),
      durationMs: 1_000,
    })

    expect(metrics.tools).toMatchObject({
      attempted: 5,
      proposed: 5,
      executed: 3,
      succeeded: 1,
      failed: 3,
      denied: 1,
      duplicateArgumentSignatures: 1,
      firstTestMs: 400,
      idleAfterFinalVerificationMs: 600,
    })
    expect(metrics.tools.byEffect['filesystem.write']).toMatchObject({
      attempted: 2,
      failed: 2,
    })
    expect(metrics.patch).toEqual({
      changedFiles: 2,
      addedLines: 3,
      deletedLines: 1,
      testFilesChanged: 1,
      binaryFilesChanged: 0,
      workspaceOutsideWriteAttempts: 0,
    })
  })

  it('keeps missing provider usage unknown and never estimates it', () => {
    const trace: TraceEvent[] = [
      event('llm.request', 1, 0, {
        callId: 'missing',
        scope: 'main',
        normalizedMessages: [],
        providerRequest: {},
        requestBytes: 10,
        prefixHash: 'hash',
      }),
      event('llm.request', 2, 10, {
        callId: 'known',
        scope: 'approval',
        normalizedMessages: [],
        providerRequest: {},
        requestBytes: 10,
        prefixHash: 'hash',
      }),
      event('llm.usage', 3, 20, {
        callId: 'known',
        usage: {
          scope: 'approval',
          providerId: 'provider',
          providerLabel: 'Provider',
          model: 'model',
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          reasoningTokens: 0,
          cacheHitTokens: 40,
          cacheMissTokens: 60,
          contextWindowTokens: 10_000,
          contextWindowSource: 'builtin',
          raw: {},
        },
      }),
    ]
    const metrics = aggregateBenchmarkMetrics({
      trace,
      patch: '',
      durationMs: 25,
      priceSnapshot: priceSnapshot(),
    })

    expect(metrics.usage.byScope.main).toMatchObject({
      records: 1,
      missingRecords: 1,
      promptTokens: null,
      totalTokens: null,
    })
    expect(metrics.usage.byScope.approval).toMatchObject({
      records: 1,
      missingRecords: 0,
      promptTokens: 100,
      totalTokens: 120,
    })
    expect(metrics.usage.total.totalTokens).toBeNull()
    expect(metrics.cost.byScope.approval).toBeCloseTo(0.00014)
    expect(metrics.cost.totalUsd).toBeNull()
  })
})

function attempt(
  seq: number,
  offsetMs: number,
  callId: string,
  tool: string,
  stage: 'validation' | 'permission' | 'execution',
  outcome: 'rejected' | 'denied' | 'failed' | 'succeeded',
  extra: { effects: string[]; errorCode?: string },
): TraceEvent {
  return event('tool.attempt', seq, offsetMs, {
    callId,
    tool,
    stage,
    outcome,
    effects: extra.effects,
    durationMs: 10,
    inputBytes: 5,
    outputBytes: 8,
    truncated: false,
    errorCode: extra.errorCode,
  })
}

function call(
  seq: number,
  offsetMs: number,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  status: 'ok' | 'error' | 'denied',
): TraceEvent {
  return event('tool.call', seq, offsetMs, {
    callId,
    tool,
    args,
    result:
      status === 'ok'
        ? { status, content: {} }
        : status === 'error'
          ? { status, code: 'FAIL', message: 'failed', retryable: false }
          : { status, message: 'denied' },
    approvedBy: 'none',
    policySignals: [],
    durationMs: 10,
  })
}

function event(
  type: TraceEvent['type'],
  seq: number,
  offsetMs: number,
  fields: Record<string, unknown>,
): TraceEvent {
  return {
    schemaVersion: 1,
    seq,
    eventId: `event-${seq}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, offsetMs)).toISOString(),
    type,
    sessionId: 'session',
    runId: 'run',
    ...fields,
  } as TraceEvent
}

function priceSnapshot(): BenchmarkPriceSnapshot {
  return {
    schemaVersion: 1,
    id: 'pricing-2026-01',
    source: 'test fixture',
    revision: '1',
    currency: 'USD',
    providerId: 'provider',
    model: 'model',
    ratesPerMillionTokens: {
      promptTokens: 1,
      completionTokens: 2,
    },
  }
}
