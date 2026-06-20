import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, EventId, RunId, SessionId } from '../../shared/ids'
import type { TraceId } from '../../shared/trace'
import { createTraceEvent, type TraceEventInput } from './events'
import { TraceService } from './service'

const traceId = 'session-replay' as TraceId
const sessionId = 'session-replay' as SessionId
const runId = 'run-replay' as RunId
const llmCallId = 'call-llm' as CallId

async function writeTrace(
  directory: string,
  inputs: TraceEventInput[],
): Promise<EventId[]> {
  const ids = inputs.map((_, index) => `event-${index + 1}` as EventId)
  const events = inputs.map((input, index) =>
    createTraceEvent(
      input,
      index + 1,
      ids[index]!,
      new Date(Date.UTC(2026, 5, 20, 0, 0, index)).toISOString(),
    ),
  )
  await writeFile(
    path.join(directory, `${traceId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  )
  return ids
}

describe('TraceService', () => {
  it('lists and deterministically replays a closed trace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-service-'))
    const service = new TraceService(directory)
    await service.initialize()
    await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
      { type: 'run.start', sessionId, runId },
      { type: 'user.message', sessionId, runId, text: 'hello' },
      { type: 'agent.message', sessionId, runId, text: 'world' },
      { type: 'run.end', sessionId, runId, status: 'completed' },
      { type: 'session.end', sessionId },
    ])

    await expect(service.list()).resolves.toMatchObject([
      { traceId, closed: true, eventCount: 6 },
    ])
    const first = await service.replay(traceId)
    const second = await service.replay(traceId)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      closed: true,
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'world' },
      ],
      runs: [{ runId, status: 'completed' }],
      forkPoints: [],
    })
  })

  it('reports provider usage exactly and marks absent values as null', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-stats-'))
    const service = new TraceService(directory)
    await service.initialize()
    await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
      {
        type: 'llm.request',
        sessionId,
        runId,
        callId: llmCallId,
        normalizedMessages: [],
        providerRequest: {},
        requestBytes: 123,
        prefixHash: 'hash',
        prefixFingerprints: ['prefix-a'],
      },
      {
        type: 'llm.response',
        sessionId,
        runId,
        callId: llmCallId,
        rawResponse: {},
        normalizedTurn: {},
        usage: {
          prompt_tokens: 10,
          total_tokens: 14,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 3,
        },
        timing: { ttftMs: 5, totalMs: 20 },
      },
      { type: 'session.end', sessionId },
    ])

    await expect(service.stats(traceId)).resolves.toEqual({
      requestCount: 1,
      requestBytes: 123,
      promptTokens: 10,
      completionTokens: null,
      totalTokens: 14,
      cacheHitTokens: 7,
      cacheMissTokens: 3,
      averageTtftMs: 5,
      averageTotalMs: 20,
      prefixFingerprints: ['prefix-a'],
    })
  })

  it('extracts only the selected request as a fork point', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-fork-'))
    const service = new TraceService(directory)
    await service.initialize()
    const ids = await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'confirm',
      },
      {
        type: 'tool.call',
        sessionId,
        runId,
        callId: 'call-old-tool' as CallId,
        tool: 'apply_patch',
        args: { path: 'note.txt' },
        result: { status: 'ok' },
        approvedBy: 'human',
        policySignals: [],
        durationMs: 1,
      },
      {
        type: 'llm.request',
        sessionId,
        runId,
        callId: llmCallId,
        normalizedMessages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'continue' },
        ],
        providerRequest: { opaque: true },
        requestBytes: 20,
        prefixHash: 'hash',
      },
    ])

    await expect(service.forkPoint(traceId, ids[2]!)).resolves.toEqual({
      workspace: 'F:/workspace',
      mode: 'confirm',
      sourceEventId: ids[2],
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'continue' },
      ],
      providerRequest: { opaque: true },
    })
  })

  it('clears only closed traces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-clear-'))
    const service = new TraceService(directory)
    await service.initialize()
    await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
      { type: 'session.end', sessionId },
    ])

    await expect(service.clearClosed(new Set())).resolves.toBe(1)
    await expect(service.list()).resolves.toEqual([])
  })
})
