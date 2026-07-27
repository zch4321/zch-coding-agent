import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
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
const modelRoute = {
  schemaVersion: 2 as const,
  purpose: 'main' as const,
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'fixture',
  reasoning: 'off' as const,
  endpoint: 'https://api.example/chat/completions',
  providerConfigRevision: 1,
}

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
      {
        traceId,
        closed: true,
        eventCount: 6,
      },
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
    })
  })

  it('paginates transcript entries and provider request messages', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-pages-'))
    const service = new TraceService(directory)
    const ids = await writeTrace(directory, [
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
        normalizedMessages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'hello' },
        ],
        providerRequest: {},
        requestBytes: 10,
        prefixHash: 'hash',
        canonicalSource: [],
        modelRoute,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'user.message' as const,
        sessionId,
        runId,
        text: `message-${index}`,
      })),
    ])

    const first = await service.transcriptPage({ traceId, limit: 3 })
    expect(first.entries).toHaveLength(3)
    expect(first.nextCursor).toBeTruthy()
    const second = await service.transcriptPage({
      traceId,
      cursor: first.nextCursor,
      limit: 3,
    })
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id)
    const request = await service.transcriptRequestMessages({
      traceId,
      requestEventId: ids[1]!,
      limit: 1,
    })
    expect(request.messages).toEqual([{ role: 'system', content: 'system' }])
    expect(request.nextCursor).toBeTruthy()
    await expect(
      service.transcriptPage({ traceId, cursor: request.nextCursor }),
    ).rejects.toMatchObject({ code: 'TRACE_CURSOR_INVALID' })
  })

  it('rejects stale transcript cursors after an active trace changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-stale-'))
    const service = new TraceService(directory)
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
    ])
    const first = await service.transcriptPage({ traceId, limit: 1 })
    const appended = createTraceEvent(
      { type: 'run.end', sessionId, runId, status: 'completed' },
      4,
      'event-4' as EventId,
      '2026-06-20T00:01:00.000Z',
    )
    await appendFile(
      path.join(directory, `${traceId}.jsonl`),
      `${JSON.stringify(appended)}\n`,
    )
    await expect(
      service.transcriptPage({ traceId, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'TRACE_CURSOR_STALE' })
  })

  it('paginates by serialized bytes and rejects malformed cursors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-bytes-'))
    const service = new TraceService(directory)
    await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        type: 'user.message' as const,
        sessionId,
        runId,
        text: `${index}:`.padEnd(900_000, 'x'),
      })),
    ])
    const page = await service.transcriptPage({ traceId, limit: 100 })
    expect(page.entries.length).toBeLessThan(4)
    expect(page.nextCursor).toBeTruthy()
    await expect(
      service.transcriptPage({ traceId, cursor: 'not-base64-json' }),
    ).rejects.toMatchObject({ code: 'TRACE_CURSOR_INVALID' })
  })

  it('ignores an incomplete final line and rejects traces over 32 MiB', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'trace-bounds-'))
    const service = new TraceService(directory)
    await writeTrace(directory, [
      {
        type: 'session.start',
        sessionId,
        workspace: 'F:/workspace',
        model: 'fixture',
        mode: 'readonly',
      },
    ])
    await appendFile(path.join(directory, `${traceId}.jsonl`), '{"partial":')
    await expect(service.transcriptPage({ traceId })).resolves.toMatchObject({
      total: 1,
    })

    const oversized = 'oversized-trace' as TraceId
    await writeFile(
      path.join(directory, `${oversized}.jsonl`),
      Buffer.alloc(32 * 1_024 * 1_024 + 1),
    )
    await expect(
      service.transcriptPage({ traceId: oversized }),
    ).rejects.toMatchObject({ code: 'TRACE_TOO_LARGE' })
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
        canonicalSource: [],
        modelRoute,
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
      {
        type: 'llm.usage',
        sessionId,
        runId,
        callId: llmCallId,
        usage: {
          scope: 'main',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'fixture',
          promptTokens: 10,
          totalTokens: 14,
          cacheHitTokens: 7,
          cacheMissTokens: 3,
          contextWindowTokens: 64_000,
          contextWindowSource: 'default',
          raw: {
            prompt_tokens: 10,
            total_tokens: 14,
            prompt_cache_hit_tokens: 7,
            prompt_cache_miss_tokens: 3,
          },
        },
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
