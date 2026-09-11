// @vitest-environment jsdom
import { Writable } from 'node:stream'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import type { LlmUsageRecord } from '../../shared/usage'
import type { AgentExecutionSummary } from '../../shared/agent-execution'
import {
  AgentExecutionUsageSummarySchema,
  addExecutionUsage,
  emptyExecutionUsage,
  parseExecutionUsage,
  summarizeExecutionUsage,
} from '../../shared/execution-usage'
import { addUsageTotals, type UsageTotals } from '../../shared/session-usage'
import { HeadlessResultSchema } from '../../electron/headless/contracts'
import {
  HeadlessEventWriter,
  HeadlessRunMetrics,
} from '../../electron/headless/event-stream'
import { summarizeSubagentUsage } from '../../electron/subagent/contracts'
import {
  addUsage,
  emptyUsage,
  recordUsage,
} from '../../electron/swarm/job-validation'
import { useAgentExecutionStore } from './agent-executions'

const records: LlmUsageRecord[] = [
  {
    scope: 'main',
    providerId: 'fixture',
    providerLabel: 'Fixture',
    model: 'model',
    contextWindowTokens: 4096,
    contextWindowSource: 'default',
    raw: { private: 'provider-only' },
    promptTokens: 12,
    completionTokens: 5,
    totalTokens: 17,
    reasoningTokens: 2,
    cacheHitTokens: 3,
    cacheMissTokens: 9,
  },
  {
    scope: 'approval',
    providerId: 'fixture',
    providerLabel: 'Fixture',
    model: 'model',
    contextWindowTokens: 4096,
    contextWindowSource: 'default',
    raw: {},
    promptTokens: 4,
    completionTokens: 1,
  },
]

describe('execution usage across consumers', () => {
  it('keeps Main, renderer, headless and Swarm totals identical for optional metrics', () => {
    setActivePinia(createPinia())
    const store = useAgentExecutionStore()
    const summary = {
      schemaVersion: 1,
      id: 'execution:usage',
      kind: 'subagent',
      parentSessionId: 'session:parent',
      parentRunId: 'run:parent',
      parentCallId: 'call:parent',
      name: 'worker',
      status: 'running',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    } as AgentExecutionSummary
    store.upsertSummary(summary)
    const metrics = new HeadlessRunMetrics(
      new HeadlessEventWriter(
        new Writable({
          write(_chunk, _encoding, done) {
            done()
          },
        }),
      ),
    )
    records.forEach((usage, index) => {
      const base = {
        schemaVersion: 1 as const,
        seq: index + 1,
        ts: summary.createdAt,
        type: 'llm.usage' as const,
        callId: summary.parentCallId,
        usage,
      }
      store.handleEvent({
        ...base,
        executionId: summary.id,
        parentSessionId: summary.parentSessionId,
        parentRunId: summary.parentRunId,
        parentCallId: summary.parentCallId,
      })
      metrics.onAgentEvent({
        ...base,
        sessionId: summary.parentSessionId,
        runId: summary.parentRunId,
      })
    })
    const swarm = emptyUsage()
    for (const record of records)
      addUsage(swarm, summarizeSubagentUsage([record]))
    const expected = {
      records: 2,
      promptTokens: 16,
      completionTokens: 6,
      reasoningTokens: 2,
      totalTokens: 17,
      cacheHitTokens: 3,
      cacheMissTokens: 9,
    }
    expect(summarizeSubagentUsage(records)).toEqual(expected)
    expect(metrics.usage).toEqual(expected)
    expect(store.sessions[summary.parentSessionId]?.records[0]?.usage).toEqual(
      expected,
    )
    expect(swarm).toEqual(expected)
    expect(JSON.stringify(swarm)).not.toContain('provider-only')
  })

  it('shares integer bounds, safe projection and saturation without changing optional Session totals', () => {
    const empty = emptyExecutionUsage()
    expect(summarizeExecutionUsage([])).toEqual(empty)
    expect(parseExecutionUsage({ ...empty, private: 'drop' })).toEqual(empty)
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      const invalid = { ...empty, totalTokens: value }
      expect(parseExecutionUsage(invalid)).toBeUndefined()
      expect(Value.Check(AgentExecutionUsageSummarySchema, invalid)).toBe(false)
      expect(Value.Check(HeadlessResultSchema.properties.usage, invalid)).toBe(
        false,
      )
      expect(
        recordUsage({ usage: invalid } as Parameters<typeof recordUsage>[0]),
      ).toEqual(empty)
    }
    const maximum = {
      ...empty,
      records: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    }
    addExecutionUsage(maximum, { ...empty, records: 1, totalTokens: 17 })
    expect(maximum.records).toBe(Number.MAX_SAFE_INTEGER)
    expect(maximum.totalTokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(Value.Check(HeadlessResultSchema.properties.usage, maximum)).toBe(
      true,
    )
    const session: UsageTotals = { calls: 0 }
    addUsageTotals(session, { calls: 1 })
    expect(session).toEqual({ calls: 1 })
  })
})
