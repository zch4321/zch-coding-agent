import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import { BackgroundAgentHandleRegistry } from './agent-handle-registry'
import { BackgroundTaskService } from './service'

const parentSessionId = 'session:background' as SessionId

function record(
  input: Partial<SubagentExecutionRecord> &
    Pick<SubagentExecutionRecord, 'id' | 'kind' | 'status'>,
): SubagentExecutionRecord {
  return {
    name: input.kind === 'swarm' ? 'Swarm' : 'Worker',
    parentSessionId,
    parentRunId: 'run:background' as never,
    parentCallId: 'call:background' as never,
    specHash: 'a'.repeat(64),
    route: {},
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...input,
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'background-service-'))
  const sessionTemp = {
    root,
    artifacts: path.join(root, 'artifacts'),
    scratch: path.join(root, 'scratch'),
  }
  await Promise.all([
    mkdir(sessionTemp.artifacts, { recursive: true }),
    mkdir(sessionTemp.scratch, { recursive: true }),
  ])
  const standalone = record({
    id: 'subagent-running' as AgentExecutionId,
    kind: 'subagent',
    status: 'running',
  })
  const swarm = record({
    id: 'swarm-complete' as AgentExecutionId,
    kind: 'swarm',
    status: 'completed',
    result: { complete: true },
  })
  const swarmChild = record({
    id: 'subagent-swarm-child' as AgentExecutionId,
    kind: 'subagent',
    name: 'Swarm child',
    status: 'completed',
    parentExecutionId: swarm.id,
    childOrdinal: 0,
  })
  const records = new Map(
    [standalone, swarm, swarmChild].map((entry) => [entry.id, entry] as const),
  )
  const activityPath = path.join(
    sessionTemp.artifacts,
    'subagents',
    standalone.id,
    'activity.jsonl',
  )
  const manifestPath = path.join(
    sessionTemp.artifacts,
    'swarms',
    swarm.id,
    'manifest.json',
  )
  await mkdir(path.dirname(activityPath), { recursive: true })
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(activityPath, '{"status":"running"}\n')
  await writeFile(manifestPath, '{}\n')
  const cancelSubagent = vi.fn(() => true)
  const cancelSwarm = vi.fn(async () => true)
  const cancelTerminal = vi.fn(() => true)
  const state = {
    getExecution: vi.fn(async (_sessionId: SessionId, id: AgentExecutionId) =>
      records.get(id),
    ),
    executionCounts: vi.fn(async () => ({
      total: 1,
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
    })),
    listChildren: vi.fn(async () => [swarmChild]),
    listRoots: vi.fn(async () => ({
      records: [standalone, swarm],
      hasMore: false,
    })),
  }
  const terminal = {
    terminalId: 7,
    status: 'running' as const,
    exitCode: null,
    cursor: 42,
    artifactAvailable: true,
    artifactPath: path.join(
      sessionTemp.artifacts,
      'terminals',
      'terminal-7.log',
    ),
    createdAt: '2026-08-28T01:00:00.000Z',
  }
  const terminals = {
    backgroundSnapshot: vi.fn(() => terminal),
    listBackground: vi.fn(() => [terminal]),
    cancelBackground: cancelTerminal,
  }
  const handles = new BackgroundAgentHandleRegistry()
  const standaloneTargetId = handles.expose({
    executionId: standalone.id,
    parentSessionId,
    type: 'subagent',
  })
  const swarmTargetId = handles.expose({
    executionId: swarm.id,
    parentSessionId,
    type: 'swarm',
  })
  const service = new BackgroundTaskService({
    state: state as never,
    subagents: { cancel: cancelSubagent } as never,
    swarms: { cancel: cancelSwarm } as never,
    terminals: terminals as never,
    handles,
  })
  return {
    service,
    sessionTemp,
    standalone,
    standaloneTargetId,
    swarm,
    swarmTargetId,
    cancelSubagent,
    cancelSwarm,
    cancelTerminal,
  }
}

describe('BackgroundTaskService', () => {
  it('returns mixed snapshots immediately and applies any/all semantics', async () => {
    const target = await fixture()
    const context = {
      parentSessionId,
      sessionTemp: target.sessionTemp,
      signal: new AbortController().signal,
      targets: [
        { type: 'subagent' as const, id: target.standaloneTargetId },
        { type: 'swarm' as const, id: target.swarmTargetId },
      ],
      timeoutMs: 0,
    }

    await expect(
      target.service.wait({ ...context, mode: 'any' }),
    ).resolves.toMatchObject({ timedOut: false })
    await expect(
      target.service.wait({ ...context, mode: 'all' }),
    ).resolves.toMatchObject({ timedOut: true })
  })

  it('lists roots with artifact paths and a filter-bound cursor', async () => {
    const target = await fixture()
    const result = await target.service.list({
      parentSessionId,
      sessionTemp: target.sessionTemp,
      signal: new AbortController().signal,
      status: 'all',
      limit: 2,
    })

    expect(result).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ type: 'terminal', id: 7 }),
        expect.objectContaining({
          type: 'swarm',
          id: expect.any(Number),
          manifestPath: expect.any(String),
          children: [
            expect.objectContaining({
              target: { type: 'subagent', id: expect.any(Number) },
            }),
          ],
        }),
      ]),
      hasMore: true,
      nextCursor: expect.any(String),
    })
  })

  it('continues from a same-stream Terminal cursor without skipping Agent roots', async () => {
    const target = await fixture()
    const first = (await target.service.list({
      parentSessionId,
      sessionTemp: target.sessionTemp,
      signal: new AbortController().signal,
      status: 'all',
      limit: 1,
    })) as { tasks: Array<{ type: string }>; nextCursor: string }
    expect(first.tasks).toEqual([expect.objectContaining({ type: 'terminal' })])

    const second = (await target.service.list({
      parentSessionId,
      sessionTemp: target.sessionTemp,
      signal: new AbortController().signal,
      status: 'all',
      limit: 1,
      cursor: first.nextCursor,
    })) as { tasks: Array<{ type: string }> }
    expect(second.tasks).toEqual([expect.objectContaining({ type: 'swarm' })])

    await expect(
      target.service.list({
        parentSessionId: 'session:other' as SessionId,
        sessionTemp: target.sessionTemp,
        signal: new AbortController().signal,
        status: 'all',
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'BACKGROUND_CURSOR_INVALID' })
  })

  it('keeps a paged list inside the frozen byte limit', async () => {
    const target = await fixture()
    target.standalone.error = {
      code: 'LONG_FAILURE',
      message: 'x'.repeat(65_536),
    }
    const result = await target.service.list({
      parentSessionId,
      sessionTemp: target.sessionTemp,
      signal: new AbortController().signal,
      outputLimits: { maxToolOutputBytes: 512, maxToolOutputLines: 1 },
      status: 'all',
      limit: 20,
    })

    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(512)
    expect(result).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    })
  })

  it('routes approval-free cancellation to the exact owned target', async () => {
    const target = await fixture()
    await expect(
      target.service.cancel({
        parentSessionId,
        sessionTemp: target.sessionTemp,
        signal: new AbortController().signal,
        target: { type: 'subagent', id: target.standaloneTargetId },
        waitMs: 0,
      }),
    ).resolves.toMatchObject({ cancellationRequested: true })
    expect(target.cancelSubagent).toHaveBeenCalledWith(
      parentSessionId,
      target.standalone.id,
    )
  })
})
