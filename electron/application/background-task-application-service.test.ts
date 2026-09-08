import { readFile, rm, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import {
  backgroundTaskKey,
  isBackgroundTaskActive,
} from '../../shared/background-tasks'
import { BackgroundTaskService } from '../background/service'
import { BackgroundAgentHandleRegistry } from '../background/agent-handle-registry'
import { RuntimeEventBus } from '../runtime/runtime-event-bus'
import {
  SubagentRepository,
  type SubagentExecutionRecord,
} from '../persistence/subagent-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import {
  projectFixture,
  sessionFixture,
  FIXTURE_HASH,
  FIXTURE_TIMESTAMP,
} from '../persistence/repository-fixtures'
import { createTestDatabase } from '../persistence/test-database'
import { createTerminalHarness } from '../terminal/terminal-test-support'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { BackgroundTaskApplicationService } from './background-task-application-service'
import { SubagentStateService } from './subagent-state-service'

const parent = 'session:background-parent' as SessionId
const other = 'session:background-other' as SessionId
const hidden = 'session:hidden-worker' as SessionId
const backendInstanceId = 'backend:background-test'

function record(index: number): SubagentExecutionRecord {
  const createdAt = new Date(
    Date.parse(FIXTURE_TIMESTAMP) + index * 1000,
  ).toISOString()
  return {
    id: `subagent:${index}` as AgentExecutionId,
    kind: index === 2 ? 'swarm' : 'subagent',
    name: `worker ${index}`,
    parentSessionId: parent,
    parentRunId: `run:${index}` as RunId,
    parentCallId: `call:${index}` as CallId,
    status: index < 3 ? 'running' : 'completed',
    route: { apiKey: 'must-not-leak' },
    specHash: FIXTURE_HASH,
    createdAt,
    updatedAt: createdAt,
  }
}

async function fixture(rootCount = 1) {
  const database = await createTestDatabase()
  const terminals = await createTerminalHarness()
  const coordinator = new ApplicationStateCoordinator({
    database: database.database,
    backendInstanceId,
  })
  const events = new RuntimeEventBus({ backendInstanceId })
  terminals.pool.subscribeBackground((owner) => events.publishBackground(owner))
  const state = new SubagentStateService({ coordinator })
  const cancel = vi.fn(async () => true)
  const tasks = new BackgroundTaskService({
    state,
    terminals: terminals.pool,
    handles: new BackgroundAgentHandleRegistry(),
    subagents: {
      cancel,
      runOne: async () => {
        throw new Error('unused')
      },
      runPrepared: async () => {
        throw new Error('unused')
      },
    },
    swarms: {
      cancel,
      run: async () => {
        throw new Error('unused')
      },
    },
  })
  const service = new BackgroundTaskApplicationService({
    coordinator,
    events,
    terminals: terminals.pool,
    tasks,
    stopRequested: () => false,
  })
  const repository = new SubagentRepository()
  await database.database.withTransaction((transaction) => {
    new ProjectRepository().insert(transaction, projectFixture())
    const sessions = new SessionRepository()
    for (const id of [parent, other, hidden])
      sessions.insert(transaction, sessionFixture({ id, lastSeq: 0 }))
    for (let index = 0; index < rootCount; index += 1)
      repository.insert(transaction, record(index))
    repository.attachSession(transaction, {
      sessionId: hidden,
      executionId: record(0).id,
      parentSessionId: parent,
      createdAt: FIXTURE_TIMESTAMP,
    })
    if (rootCount >= 3)
      for (let index = 0; index < 4; index += 1)
        repository.insert(transaction, {
          ...record(2),
          id: `child:${index}` as AgentExecutionId,
          kind: 'subagent',
          parentExecutionId: record(2).id,
          childOrdinal: index,
        })
  })
  return {
    ...terminals,
    service,
    events,
    cancel,
    state,
    async cleanup() {
      await terminals.dispose()
      events.dispose()
      await coordinator.close()
      await database.dispose()
    },
  }
}

describe('Background task UI application service', () => {
  it('paginates active roots and all owned terminals without counting nested children twice', async () => {
    const target = await fixture(70)
    try {
      const manual = await target.pool.open({
        sessionId: parent,
        workspace: target.root,
      })
      const child = await target.pool.open({
        sessionId: hidden,
        ownerSessionId: parent,
        workspace: target.root,
      })
      await target.pool.open({ sessionId: other, workspace: target.root })
      const first = await target.service.list({ parentSessionId: parent })
      expect(first.records).toHaveLength(50)
      expect(first.activeCount).toBe(5)
      expect(first.records.slice(0, 5).every(isBackgroundTaskActive)).toBe(true)
      expect(
        first.records
          .filter((task) => task.kind === 'terminal')
          .map((task) => task.terminalId),
      ).toEqual(expect.arrayContaining([manual.terminalId, child.terminalId]))
      const second = await target.service.list({
        parentSessionId: parent,
        before: first.nextBefore,
      })
      expect(second.hasMore).toBe(false)
      expect(
        new Set([...first.records, ...second.records].map(backgroundTaskKey))
          .size,
      ).toBe(72)
      expect(JSON.stringify(first)).not.toContain(hidden)
      expect(JSON.stringify(first)).not.toContain('must-not-leak')
      await expect(
        target.service.list({
          parentSessionId: other,
          before: first.nextBefore,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(
        target.service.list({ parentSessionId: hidden }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await target.cleanup()
    }
  })

  it('enforces task ownership and the backend instance before cancellation or file access', async () => {
    const target = await fixture()
    try {
      const terminal = await target.pool.open({
        sessionId: hidden,
        ownerSessionId: parent,
        workspace: target.root,
        sessionTemp: target.sessionTemp,
      })
      await expect(
        target.service.cancel({
          parentSessionId: other,
          backendInstanceId,
          target: { kind: 'subagent', executionId: record(0).id },
        }),
      ).rejects.toThrow()
      await expect(
        target.service.cancel({
          parentSessionId: parent,
          backendInstanceId: 'old-backend',
          target: { kind: 'terminal', terminalId: terminal.terminalId },
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
      await expect(
        target.service.tail({
          parentSessionId: other,
          backendInstanceId,
          terminalId: terminal.terminalId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        target.service.tail({
          parentSessionId: parent,
          backendInstanceId: 'old-backend',
          terminalId: terminal.terminalId,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
      expect(target.cancel).not.toHaveBeenCalled()
      expect(target.ptys[0]!.killed).toBe(0)
      await expect(
        target.service.cancel({
          parentSessionId: parent,
          backendInstanceId,
          target: { kind: 'subagent', executionId: record(0).id },
        }),
      ).resolves.toEqual({ accepted: true })
      expect(target.cancel).toHaveBeenCalledWith(parent, record(0).id)
    } finally {
      await target.cleanup()
    }
  })

  it('reads the artifact file instead of scrollback and preserves status when that file disappears', async () => {
    const target = await fixture()
    try {
      const terminal = await target.pool.open({
        sessionId: hidden,
        ownerSessionId: parent,
        workspace: target.root,
        sessionTemp: target.sessionTemp,
      })
      target.ptys[0]!.emitData('memory output\n')
      await vi.waitFor(async () =>
        expect(await readFile(terminal.artifactPath!, 'utf8')).toContain(
          'memory output',
        ),
      )
      await writeFile(terminal.artifactPath!, 'artifact text\n')
      expect(
        await target.service.tail({
          parentSessionId: parent,
          backendInstanceId,
          terminalId: terminal.terminalId,
        }),
      ).toMatchObject({
        available: true,
        content: 'artifact text\n',
        cursor: { backendInstanceId },
      })
      await rm(terminal.artifactPath!)
      expect(
        await target.service.tail({
          parentSessionId: parent,
          backendInstanceId,
          terminalId: terminal.terminalId,
        }),
      ).toMatchObject({ available: false, error: expect.any(String) })
      expect(
        target.pool.backgroundSnapshot(parent, terminal.terminalId).status,
      ).toBe('running')
      expect(target.pool.list(parent)).toEqual([])
    } finally {
      await target.cleanup()
    }
  })
})
