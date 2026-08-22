import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  DiagnosticId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { cleanupTraces } from './cleanup'
import { JsonlTraceLogger, NullTraceLogger } from './logger'
import {
  CorruptTraceError,
  readTraceFile,
  UnsupportedTraceSchemaError,
} from './reader'

const sessionId = 'session-trace' as SessionId

describe('JsonlTraceLogger', () => {
  it('writes 10,000 concurrent events with complete monotonic sequence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const logger = await JsonlTraceLogger.create(directory, sessionId, {
      maxQueueSize: 32,
      highWaterMark: 256,
    })

    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        logger.write({
          type: 'user.message',
          sessionId,
          text: `message-${index}`,
        }),
      ),
    )
    await logger.dispose()

    const events = await readTraceFile(
      path.join(directory, `${logger.traceId}.jsonl`),
    )
    expect(events).toHaveLength(10_000)
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1),
    )
    expect(logger.queuePeak).toBeLessThanOrEqual(32)
  }, 30_000)

  it('ignores an incomplete final line after a crash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const logger = await JsonlTraceLogger.create(directory, sessionId)
    const filePath = path.join(directory, `${logger.traceId}.jsonl`)
    await logger.write({
      type: 'session.start',
      sessionId,
      workspace: 'F:/workspace',
      model: 'test',
      mode: 'readonly',
    })
    await logger.dispose()
    await appendFile(filePath, '{"schemaVersion":1,"seq":2')

    const events = await readTraceFile(filePath)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('session.start')
  })

  it('projects legacy route identity while leaving JSONL bytes unchanged', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const filePath = path.join(directory, 'legacy-route.jsonl')
    const legacyEvent = {
      schemaVersion: 2,
      seq: 1,
      eventId: 'event:legacy-route',
      ts: '2026-07-27T00:00:00.000Z',
      type: 'llm.request',
      sessionId,
      runId: 'run:legacy-route',
      callId: 'call:legacy-route',
      scope: 'main',
      normalizedMessages: [],
      providerRequest: {},
      requestBytes: 0,
      prefixHash: '',
      canonicalSource: [],
      modelRoute: {
        schemaVersion: 1,
        purpose: 'main',
        adapterId: 'openai-compatible.chat-completions',
        providerId: 'generic',
        model: 'legacy-model',
        reasoning: 'off',
        endpoint: 'https://provider.invalid/v1/chat/completions',
        providerConfigRevision: 3,
      },
    }
    const original = `${JSON.stringify(legacyEvent)}\n`
    await writeFile(filePath, original)

    const events = await readTraceFile(filePath)

    expect(events[0]).toMatchObject({
      schemaVersion: 3,
      type: 'llm.request',
      modelRoute: {
        schemaVersion: 2,
        providerType: 'generic.chat-completions',
        providerId: 'generic',
      },
    })
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original)
  })

  it('projects legacy v2 stream records for read-only compatibility', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const filePath = path.join(directory, 'legacy-stream.jsonl')
    const legacyEvent = {
      schemaVersion: 2,
      seq: 1,
      eventId: 'event:legacy-stream',
      ts: '2026-07-27T00:00:00.000Z',
      type: 'llm.stream',
      sessionId,
      runId: 'run:legacy-stream',
      callId: 'call:legacy-stream',
      providerEvent: { type: 'text.delta', delta: 'legacy' },
      elapsedMs: 1,
    }
    await writeFile(filePath, `${JSON.stringify(legacyEvent)}\n`)

    await expect(readTraceFile(filePath)).resolves.toMatchObject([
      {
        schemaVersion: 3,
        type: 'llm.stream',
        providerEvent: { delta: 'legacy' },
      },
    ])
  })

  it('writes and validates one aggregate v3 Provider failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const logger = await JsonlTraceLogger.create(directory, sessionId)
    await logger.write({
      type: 'llm.failure',
      sessionId,
      runId: 'run:failure' as RunId,
      callId: 'call:failure' as CallId,
      agentExecutionId: 'execution:failure' as AgentExecutionId,
      operation: 'main',
      stage: 'transport',
      code: 'PROVIDER_JSON_INVALID',
      diagnosticId: 'diagnostic:failure' as DiagnosticId,
      message: 'Provider returned invalid JSON',
      evidence: {
        kind: 'invalid_json',
        content: 'not-json',
        observedBytes: 8,
        capturedBytes: 8,
        truncated: false,
        sha256: '0'.repeat(64),
      },
    })
    await logger.dispose()

    await expect(
      readTraceFile(path.join(directory, `${logger.traceId}.jsonl`)),
    ).resolves.toMatchObject([
      {
        schemaVersion: 3,
        type: 'llm.failure',
        diagnosticId: 'diagnostic:failure',
        agentExecutionId: 'execution:failure',
      },
    ])
  })

  it('creates unique safe captures for Session ids with reserved characters', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const durableSessionId = 'session:durable:one' as SessionId
    const first = await JsonlTraceLogger.create(directory, durableSessionId)
    const second = await JsonlTraceLogger.create(directory, durableSessionId)
    await first.write({
      type: 'session.end',
      sessionId: durableSessionId,
    })
    await second.write({
      type: 'session.end',
      sessionId: durableSessionId,
    })
    await Promise.all([first.dispose(), second.dispose()])

    expect(first.traceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
    expect(second.traceId).not.toBe(first.traceId)
    await expect(
      readTraceFile(path.join(directory, `${first.traceId}.jsonl`)),
    ).resolves.toHaveLength(1)
    await expect(
      readTraceFile(path.join(directory, `${second.traceId}.jsonl`)),
    ).resolves.toHaveLength(1)
  })

  it('rejects complete pre-P3 trace schemas', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const filePath = path.join(directory, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        eventId: 'event-v1',
        ts: '2026-01-01T00:00:00.000Z',
        type: 'session.end',
        sessionId,
      })}\n`,
    )

    await expect(readTraceFile(filePath)).rejects.toBeInstanceOf(
      UnsupportedTraceSchemaError,
    )
  })

  it('classifies malformed current-schema records as corrupt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const filePath = path.join(directory, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        eventId: 'event-corrupt',
        ts: '2026-01-01T00:00:00.000Z',
        type: 'session.start',
        sessionId,
      })}\n`,
    )

    await expect(readTraceFile(filePath)).rejects.toBeInstanceOf(
      CorruptTraceError,
    )
  })

  it('does not create files when logging is disabled', async () => {
    const logger = new NullTraceLogger()
    const event = await logger.write({
      type: 'session.end',
      sessionId,
    })

    expect(event.seq).toBe(1)
    expect(logger.queuePeak).toBe(0)
  })

  it('disposes idempotently', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const logger = await JsonlTraceLogger.create(directory, sessionId)
    await logger.write({ type: 'session.end', sessionId })

    const first = logger.dispose()
    const second = logger.dispose()

    expect(second).toBe(first)
    await first
  })
})

describe('trace cleanup', () => {
  it('counts and removes legacy or invalid trace files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const legacy = path.join(directory, 'legacy.jsonl')
    await writeFile(legacy, `${JSON.stringify({ schemaVersion: 1, seq: 1 })}\n`)
    await utimes(legacy, new Date('2025-01-01'), new Date('2025-01-01'))

    const result = await cleanupTraces(directory, {
      retentionDays: 1,
      maxTotalBytes: 1_000_000,
      now: new Date('2026-06-15'),
    })

    expect(result.deleted).toEqual([legacy])
    expect(result.retainedBytes).toBe(0)
    await expect(access(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves corrupt current traces for diagnosis', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const corrupt = path.join(directory, 'corrupt-current.jsonl')
    await writeFile(
      corrupt,
      '{"schemaVersion":2,"seq":1,"type":"session.end"}\n',
    )
    await utimes(corrupt, new Date('2025-01-01'), new Date('2025-01-01'))

    const diagnostics: string[] = []
    const result = await cleanupTraces(directory, {
      retentionDays: 1,
      maxTotalBytes: 1,
      now: new Date('2026-06-15'),
      onDiagnostic: (message) => diagnostics.push(message),
    })

    expect(result.deleted).toEqual([])
    expect(result.retainedBytes).toBeGreaterThan(0)
    expect(diagnostics).toEqual([
      'Failed to inspect trace corrupt-current.jsonl',
    ])
    await expect(access(corrupt)).resolves.toBeUndefined()
  })

  it('deletes the oldest closed traces and preserves active traces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const oldClosed = path.join(directory, 'old.jsonl')
    const newerClosed = path.join(directory, 'new.jsonl')
    const active = path.join(directory, 'active.jsonl')
    const closedLine = (id: string) =>
      `${JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        eventId: `event-${id}`,
        type: 'session.end',
        sessionId: `session-${id}`,
        ts: '2026-01-01T00:00:00.000Z',
      })}\n`
    await writeFile(oldClosed, closedLine('old'))
    await writeFile(newerClosed, closedLine('new'))
    await writeFile(
      active,
      `${JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        eventId: 'event-active',
        type: 'session.start',
        sessionId: 'session-active',
        workspace: 'workspace',
        model: 'model',
        mode: 'readonly',
        ts: '2026-01-01T00:00:00.000Z',
      })}\n`,
    )
    await utimes(oldClosed, new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(newerClosed, new Date('2026-02-01'), new Date('2026-02-01'))

    const result = await cleanupTraces(directory, {
      retentionDays: 3_650,
      maxTotalBytes: 1,
      activeFiles: new Set([path.resolve(active)]),
      now: new Date('2026-06-15'),
    })

    expect(result.deleted).toEqual([oldClosed, newerClosed])
    expect(result.retainedBytes).toBeGreaterThan(0)
    await expect(readTraceFile(active)).resolves.toHaveLength(1)
  })

  it('treats concurrent cleanup of the same trace as idempotent', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const closed = path.join(directory, 'concurrent-closed.jsonl')
    await writeFile(
      closed,
      `${JSON.stringify({
        schemaVersion: 2,
        seq: 1,
        eventId: 'event-concurrent-closed',
        type: 'session.end',
        sessionId: 'session-concurrent-closed',
        ts: '2025-01-01T00:00:00.000Z',
      })}\n`,
    )
    await utimes(closed, new Date('2025-01-01'), new Date('2025-01-01'))

    const diagnostics: string[] = []
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        cleanupTraces(directory, {
          retentionDays: 1,
          maxTotalBytes: 0,
          now: new Date('2026-06-15'),
          onDiagnostic: (message) => diagnostics.push(message),
        }),
      ),
    )

    expect(diagnostics).toEqual([])
    const deleted = results.flatMap((result) => result.deleted)
    expect(deleted.length).toBeGreaterThan(0)
    expect(new Set(deleted)).toEqual(new Set([closed]))
    expect(results.every((result) => result.retainedBytes === 0)).toBe(true)
    await expect(access(closed)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
