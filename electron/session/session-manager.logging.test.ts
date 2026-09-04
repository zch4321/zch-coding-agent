import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import { readTraceFile } from '../logging/reader'
import { TraceService } from '../logging/service'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  ForkProvider,
} from './session-manager-test-support'

const timestamp = '2026-07-25T00:00:00.000Z'

describe('SessionManager trace capture switching', () => {
  it('does not rescan global traces when a trace-disabled internal Session closes', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-internal-trace-cleanup-'),
    )
    const workspace = path.join(directory, 'workspace')
    const traceDirectory = path.join(directory, 'traces')
    await Promise.all([mkdir(workspace), mkdir(traceDirectory)])
    const corruptTrace = path.join(traceDirectory, 'corrupt-current.jsonl')
    await writeFile(
      corruptTrace,
      `${JSON.stringify({
        schemaVersion: 3,
        seq: 1,
        eventId: 'event:corrupt-internal-cleanup',
        ts: '2026-08-29T00:00:00.000Z',
        type: 'session.start',
      })}\n`,
    )
    const configStore = await createConfig(directory)
    const config = configStore.getPublicConfig()
    const provider = config.models.providers[0]!
    const onDiagnostic = vi.fn()
    const manager = new SessionManager({
      configStore,
      traceDirectory,
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => new ForkProvider(),
      onDiagnostic,
    })
    const sessionId = 'session:internal-no-cleanup' as SessionId
    await manager.createInternalSession({
      sessionId,
      workspace,
      mode: 'readonly',
      provider: provider.id,
      modelSelection: {
        providerId: provider.id,
        model: provider.model,
        reasoning: config.models.defaultModelReasoning,
      },
      allowedToolIds: new Set(),
      gitToolsEnabled: true,
      providerSnapshot: provider,
      execution: {
        executionId: 'execution:internal-no-cleanup' as AgentExecutionId,
        parentSessionId: 'session:internal-parent' as SessionId,
        parentRunId: 'run:internal-parent' as RunId,
        parentCallId: 'call:internal-parent' as CallId,
        name: 'internal-no-cleanup',
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    })

    await expect(manager.closeSession(sessionId)).resolves.toBe(true)
    expect(
      onDiagnostic.mock.calls.filter(([message]) =>
        String(message).startsWith('Failed to inspect trace'),
      ),
    ).toEqual([])
    await expect(access(corruptTrace)).resolves.toBeUndefined()
    await manager.dispose()
  })

  it('enables an idle Session and creates a new capture when restored', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-trace-switching-'),
    )
    const workspace = path.join(directory, 'workspace')
    const traceDirectory = path.join(directory, 'traces')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    await configStore.update({
      version: 1,
      kind: 'logging',
      value: {
        ...configStore.getPublicConfig().logging,
        trace: {
          ...configStore.getPublicConfig().logging.trace,
          enabled: false,
        },
      },
    })
    const manager = new SessionManager({
      configStore,
      traceDirectory,
      eventSink: createIpcTestEventSink(() => undefined),
      providerFactory: () => new ForkProvider(),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    expect(manager.traceCaptureStatus(sessionId)).toEqual({
      configuredEnabled: false,
      state: 'disabled',
    })
    await configStore.update({
      version: 1,
      kind: 'logging',
      value: {
        ...configStore.getPublicConfig().logging,
        trace: {
          ...configStore.getPublicConfig().logging.trace,
          enabled: true,
        },
      },
    })
    await expect(manager.reconfigureTraceLogging(true)).resolves.toEqual([])
    const firstTraceId = manager.traceCaptureStatus(sessionId)?.traceId
    if (!firstTraceId) throw new Error('Idle Session capture was not created')

    const runId = manager.startRun({
      sessionId,
      message: 'record only future activity',
      clientRequestId: 'request:future-activity',
    })
    await manager.waitForRunSettled(sessionId, runId)
    await manager.closeSession(sessionId)

    const oldMessageId = 'message:restored-history' as MessageId
    const history: MessageRecord[] = [
      {
        schemaVersion: 1,
        id: oldMessageId,
        sessionId,
        seq: 1,
        visibility: 'visible',
        turnId: oldMessageId,
        inHistory: true,
        createdAt: timestamp,
        kind: 'user_input',
        clientRequestId: 'request:restored-history',
        parts: [{ type: 'text', text: 'history must not be backfilled' }],
        metadata: {
          schemaVersion: 1,
          submission: { type: 'message' },
        },
      },
    ]
    const record: SessionRecord = {
      schemaVersion: 1,
      id: sessionId,
      projectId: 'project:trace-switching' as ProjectId,
      title: 'Restored Session',
      titleSource: 'user',
      lifecycle: 'active',
      permissionMode: 'readonly',
      modelSelection: {
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoning: 'high',
      },
      goal: null,
      plan: null,
      revision: 1,
      lastSeq: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await manager.restoreSession({ record, workspace, history })
    const restoredTraceId = manager.traceCaptureStatus(sessionId)?.traceId
    if (!restoredTraceId) throw new Error('Restored capture was not created')
    expect(restoredTraceId).not.toBe(firstTraceId)
    await manager.closeSession(sessionId)

    const traces = (await new TraceService(traceDirectory).list()).filter(
      (trace) => trace.sessionId === sessionId,
    )
    expect(traces).toHaveLength(2)
    const firstEvents = await readTraceFile(
      path.join(traceDirectory, `${firstTraceId}.jsonl`),
    )
    const restoredEvents = await readTraceFile(
      path.join(traceDirectory, `${restoredTraceId}.jsonl`),
    )
    expect(firstEvents[0]).toMatchObject({
      seq: 1,
      type: 'session.start',
    })
    expect(restoredEvents[0]).toMatchObject({
      seq: 1,
      type: 'session.start',
    })
    expect(JSON.stringify(firstEvents)).toContain('record only future activity')
    expect(JSON.stringify(restoredEvents)).not.toContain(
      'history must not be backfilled',
    )
    await manager.dispose()
  })
})
