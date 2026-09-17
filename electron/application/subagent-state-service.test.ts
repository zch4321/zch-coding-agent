import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  ProjectId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { ProjectRepository } from '../persistence/project-repository'
import {
  FIXTURE_TIMESTAMP,
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { SessionRepository } from '../persistence/session-repository'
import {
  SubagentRepository,
  type SubagentExecutionRecord,
} from '../persistence/subagent-repository'
import { createTestDatabase } from '../persistence/test-database'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { SubagentStateService } from './subagent-state-service'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

function execution(
  id: string,
  callId: string,
  overrides: Partial<SubagentExecutionRecord> = {},
): SubagentExecutionRecord {
  return {
    id: id as AgentExecutionId,
    kind: 'subagent',
    name: id,
    parentSessionId: 'session:capacity' as SessionId,
    parentRunId: 'run:capacity' as RunId,
    parentCallId: callId as CallId,
    specHash: 'a'.repeat(64),
    status: 'preparing',
    route: {},
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  }
}

async function fixture() {
  const target = await createTestDatabase()
  disposers.push(() => target.dispose())
  const projects = new ProjectRepository()
  const sessions = new SessionRepository()
  await target.database.withTransaction((transaction) => {
    projects.insert(
      transaction,
      projectFixture({ id: 'project:capacity' as ProjectId }),
    )
    sessions.insert(
      transaction,
      sessionFixture({
        id: 'session:capacity' as SessionId,
        projectId: 'project:capacity' as ProjectId,
        lastSeq: 0,
      }),
    )
  })
  const coordinator = new ApplicationStateCoordinator({
    database: target.database,
    publish: () => undefined,
  })
  const repository = new SubagentRepository()
  return {
    coordinator,
    repository,
    state: new SubagentStateService({ coordinator }),
  }
}

describe('SubagentStateService capacity reservations', () => {
  it('releases memory reservations when the database transaction fails after insertion', async () => {
    const target = await fixture()
    const original = target.coordinator.internalCommand.bind(target.coordinator)
    vi.spyOn(target.coordinator, 'internalCommand').mockImplementationOnce(
      (operation) =>
        original((transaction) => {
          operation(transaction)
          throw new Error('Commit failed')
        }),
    )
    await expect(
      target.state.createExecution(
        execution('subagent:rollback', 'call:rollback'),
        1,
      ),
    ).rejects.toThrow()
    expect(target.state.capacity.count('session:capacity' as SessionId)).toBe(0)
    await expect(
      target.state.createExecution(execution('subagent:next', 'call:next'), 1),
    ).resolves.toMatchObject({ created: true })
  })

  it('atomically owns a persistent child, projects the latest Run and rejects foreign ownership', async () => {
    const target = await fixture()
    const initial = execution('subagent:persistent', 'call:persistent', {
      childSessionId: 'session:persistent' as SessionId,
      route: {
        main: {
          providerId: 'deepseek',
          model: 'deepseek-v4-pro',
          reasoning: 'off',
        },
      },
    })
    await target.state.createExecution(initial, 1, {
      metadata: {
        initialExecutionId: initial.id,
        delegation: {
          permissionMode: 'readonly',
          allowedToolIds: ['read_file'],
          gitToolsEnabled: true,
        },
      },
    })
    expect(
      (
        await target.state.childIdentity(
          initial.parentSessionId,
          initial.childSessionId!,
        )
      ).metadata.delegation?.allowedToolIds,
    ).toEqual(['read_file'])
    initial.status = 'completed'
    await target.state.updateExecution(initial)
    const next = execution('subagent:followup', 'call:followup', {
      childSessionId: initial.childSessionId,
      childRunId: 'run:followup' as RunId,
      route: initial.route,
      createdAt: '2026-09-17T00:00:00.000Z',
    })
    await target.state.createExecution(next, 1, { waitForCapacity: true })
    const view = (
      await target.coordinator.query((reader) => ({
        count: target.repository.countActiveRoots(
          reader,
          initial.parentSessionId,
        ),
        roots: target.repository.listBackgroundRoots(reader, {
          parentSessionId: initial.parentSessionId,
          limit: 10,
        }),
        current: target.repository.presentationRecord(reader, initial),
        public: new SessionRepository().get(reader, initial.childSessionId!),
      }))
    ).value
    expect(view.count).toBe(1)
    expect(view.roots.map((item) => item.record.id)).toEqual([initial.id])
    expect(view.current).toMatchObject({
      id: initial.id,
      status: 'preparing',
      childRunId: next.childRunId,
    })
    expect(view.public).toBeUndefined()
    await target.state.retainUnstartedMessage(
      initial.parentSessionId,
      initial.childSessionId!,
      'Keep <this> instruction',
    )
    const history = await target.state.loadRuntimeState(initial.childSessionId!)
    expect(JSON.stringify(history.activeHistory)).toContain(
      'Keep &lt;this&gt; instruction',
    )
    await expect(
      target.state.createExecution(
        execution('subagent:foreign', 'call:foreign', {
          parentSessionId: 'session:foreign' as SessionId,
          childSessionId: initial.childSessionId,
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(target.state.capacity.count('session:foreign' as SessionId)).toBe(0)
  })

  it('atomically admits one concurrent standalone leaf at a limit of one', async () => {
    const target = await fixture()
    const attempts = await Promise.allSettled([
      target.state.createExecution(
        execution('subagent:first', 'call:first'),
        1,
      ),
      target.state.createExecution(
        execution('subagent:second', 'call:second'),
        1,
      ),
    ])

    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({
      code: 'PRECONDITION_FAILED',
      capacityCode: 'SUBAGENT_CAPACITY_EXCEEDED',
    })
    expect(
      (
        await target.coordinator.query((reader) =>
          target.repository.countActiveLeaves(
            reader,
            'session:capacity' as SessionId,
          ),
        )
      ).value,
    ).toBe(1)
  })

  it('reserves a whole Swarm or none and honors a lowered future limit', async () => {
    const target = await fixture()
    const existing = execution('subagent:existing', 'call:existing')
    await target.state.createExecution(existing, 3)
    const root = execution('swarm:atomic', 'call:swarm', {
      kind: 'swarm',
      name: 'Swarm',
    })
    const children = [0, 1].map((childOrdinal) =>
      execution(`subagent:swarm-${childOrdinal}`, 'call:swarm', {
        status: 'queued',
        parentExecutionId: root.id,
        childOrdinal,
      }),
    )

    await expect(
      target.state.createSwarmJob(root, children, 2),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      capacityCode: 'SUBAGENT_CAPACITY_EXCEEDED',
    })
    await expect(
      target.state.getExecution('session:capacity' as SessionId, root.id),
    ).resolves.toBeUndefined()
    for (const child of children) {
      await expect(
        target.state.getExecution('session:capacity' as SessionId, child.id),
      ).resolves.toBeUndefined()
    }

    existing.status = 'completed'
    existing.completedAt = '2026-08-28T00:01:00.000Z'
    existing.updatedAt = existing.completedAt
    await target.state.updateExecution(existing)
    await expect(
      target.state.createSwarmJob(root, children, 2),
    ).resolves.toMatchObject({ created: true })
    await expect(
      target.state.createExecution(
        execution('subagent:after-lowering', 'call:after-lowering'),
        1,
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      capacityCode: 'SUBAGENT_CAPACITY_EXCEEDED',
    })
    await expect(target.state.executionCounts(root.id)).resolves.toMatchObject({
      total: 2,
      queued: 2,
    })
  })
})
