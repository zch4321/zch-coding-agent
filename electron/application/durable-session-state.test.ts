import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import {
  messageFixtures,
  sessionFixture,
  FIXTURE_TIMESTAMP,
} from '../persistence/repository-fixtures'
import type { SessionState } from '../session/session-types'
import { prepareSessionCommit } from '../session/durable-session-state'
import { DurableExecutionStatePort } from './durable-execution-state-port'
import type { SessionService } from './session-service'
import type { SubagentStateService } from './subagent-state-service'

function fixture(visibility: 'public' | 'internal') {
  const record = sessionFixture({
    lastSeq: 1,
    goal: {
      id: 'goal:stored',
      objective: 'Stored goal',
      status: 'active',
      continuationCount: 0,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
    plan: {
      id: 'plan:stored',
      objective: 'Stored plan',
      status: 'active',
      continuationCount: 0,
      items: [],
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
    },
  })
  const history = [messageFixtures(record.id)[0]!]
  const session = {
    sessionId: record.id,
    visibility,
    history: structuredClone(history),
    nextMessageSeq: 2,
    mode: record.permissionMode,
    provider: record.modelSelection.providerId,
    modelSelection: structuredClone(record.modelSelection),
    goal: structuredClone(record.goal),
    plan: structuredClone(record.plan),
    clientRequests: new Map(),
  } as unknown as SessionState
  const mutation = vi.fn(async () => {
    throw new Error('commit failed')
  })
  const loadRuntimeState = vi.fn(async () => ({
    record,
    activeHistory: history,
    committedClientRequestIds: [],
  }))
  const service = { commitMutation: mutation, loadRuntimeState }
  const port = new DurableExecutionStatePort(
    service as unknown as SessionService,
    service as unknown as SubagentStateService,
  )
  if (visibility === 'public') port.registerExisting(record, 'owner')
  else {
    port.registerInternalNew({ ...record, lastSeq: 0 }, 'owner', {
      executionId: 'execution:fixture' as AgentExecutionId,
      parentSessionId: 'parent' as SessionId,
      createdAt: FIXTURE_TIMESTAMP,
    })
    port.applyRecord(record.id, record, 'owner')
  }
  return { port, session, record, history, mutation, loadRuntimeState }
}

describe.each(['public', 'internal'] as const)(
  '%s durable state reconciliation',
  (visibility) => {
    it('restores goal, plan, model, mode and history after metadata commit failure without sharing references', async () => {
      const { port, session, record, history } = fixture(visibility)
      session.mode = 'auto'
      session.modelSelection.model = 'uncommitted-model'
      session.goal!.objective = 'uncommitted-goal'
      session.plan = undefined
      session.history.push(messageFixtures(record.id)[1]!)
      session.nextMessageSeq = 3
      await expect(
        port.commit(session, { reason: 'metadata' }),
      ).rejects.toThrow('commit failed')
      expect(session).toMatchObject({
        mode: record.permissionMode,
        modelSelection: record.modelSelection,
        goal: record.goal,
        plan: record.plan,
        history,
        nextMessageSeq: 2,
        modelSelectionPinned: true,
      })
      expect(session.goal).not.toBe(record.goal)
      expect(session.plan).not.toBe(record.plan)
      expect(session.history).not.toBe(history)
      expect(port.record(record.id)).toEqual(record)
    })

    it('skips empty commits but retains compaction and failed side-effect invalidation', async () => {
      const { port, session, mutation } = fixture(visibility)
      await expect(
        port.commit(session, { reason: 'metadata' }),
      ).resolves.toBeUndefined()
      expect(mutation).not.toHaveBeenCalled()
      const invalid = vi.fn()
      port.setInvalidationHandler(invalid)
      await expect(
        port.commit(session, { reason: 'tool_batch', deactivateThroughSeq: 1 }),
      ).rejects.toThrow('commit failed')
      expect(mutation).toHaveBeenCalledOnce()
      expect(invalid).toHaveBeenCalledOnce()
      expect(port.record(session.sessionId)).toBeUndefined()
    })
  },
)

it('prepares new history in sequence order and detaches metadata before asynchronous commits', () => {
  const { session, record } = fixture('public')
  session.history = [
    messageFixtures(record.id)[3]!,
    messageFixtures(record.id)[0]!,
    messageFixtures(record.id)[1]!,
  ]
  const prepared = prepareSessionCommit(session, record)
  expect(prepared.records.map((message) => message.seq)).toEqual([2, 4])
  expect(prepared.metadataChanged).toBe(false)
  session.goal!.objective = 'later'
  expect(prepared.metadata.goal?.objective).toBe('Stored goal')
  const withoutGoals: SessionRecord = { ...record, goal: null, plan: null }
  expect(prepareSessionCommit(session, withoutGoals).metadataChanged).toBe(true)
})
