import { appendFile, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { cleanupTraces } from './cleanup'
import { JsonlTraceLogger, NullTraceLogger } from './logger'
import { readTraceFile } from './reader'

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
      path.join(directory, `${sessionId}.jsonl`),
    )
    expect(events).toHaveLength(10_000)
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1),
    )
    expect(logger.queuePeak).toBeLessThanOrEqual(32)
  }, 30_000)

  it('ignores an incomplete final line after a crash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const filePath = path.join(directory, `${sessionId}.jsonl`)
    const logger = await JsonlTraceLogger.create(directory, sessionId)
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
  it('deletes the oldest closed traces and preserves active traces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-'))
    const oldClosed = path.join(directory, 'old.jsonl')
    const newerClosed = path.join(directory, 'new.jsonl')
    const active = path.join(directory, 'active.jsonl')
    const closedLine = (id: string) =>
      `${JSON.stringify({
        schemaVersion: 1,
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
        schemaVersion: 1,
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
})
