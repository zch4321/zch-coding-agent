import { describe, expect, it } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { MessageRepository } from '../persistence/message-repository'
import { ProjectRepository } from '../persistence/project-repository'
import {
  FIXTURE_HASH,
  FIXTURE_TIMESTAMP,
  messageFixtures,
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { SessionRepository } from '../persistence/session-repository'
import {
  SubagentRepository,
  type SubagentExecutionRecord,
} from '../persistence/subagent-repository'
import { createTestDatabase } from '../persistence/test-database'
import { AgentExecutionQueryService } from './agent-execution-query-service'
import { ApplicationStateCoordinator } from './application-state-coordinator'

const projects = new ProjectRepository()
const sessions = new SessionRepository()
const messages = new MessageRepository()
const subagents = new SubagentRepository()

function execution(input: {
  id: string
  parentSessionId: SessionId
  createdAt: string
  status?: SubagentExecutionRecord['status']
}): SubagentExecutionRecord {
  return {
    id: input.id as AgentExecutionId,
    parentSessionId: input.parentSessionId,
    parentRunId: `run:${input.id}` as RunId,
    parentCallId: `call:${input.id}` as CallId,
    specHash: FIXTURE_HASH,
    status: input.status ?? 'completed',
    route: {
      schemaVersion: 1,
      main: {
        providerId: 'deepseek',
        model: 'deepseek-chat',
        endpoint: 'https://private.invalid/v1',
      },
    },
    usage: {
      records: 1,
      promptTokens: 10,
      completionTokens: 4,
      reasoningTokens: 2,
      totalTokens: 14,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    },
    result: { results: { review: 'done' } },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: input.createdAt,
  }
}

describe('AgentExecutionQueryService', () => {
  it('paginates summaries and enforces public parent ownership', async () => {
    const testDatabase = await createTestDatabase()
    const coordinator = new ApplicationStateCoordinator({
      database: testDatabase.database,
      backendInstanceId: 'backend:agent-execution-query',
      publish: () => undefined,
    })
    const service = new AgentExecutionQueryService({
      coordinator,
      liveSnapshot: (sessionId) =>
        sessionId === ('session:agent-child' as SessionId)
          ? {
              schemaVersion: 1,
              sessionId,
              runId: 'run:agent-child-live' as RunId,
              status: 'calling_llm',
              text: 'Current live output',
              reasoning: 'Current live reasoning',
              tools: [
                {
                  callId: 'call:agent-child-live' as CallId,
                  tool: 'read_file',
                  status: 'running',
                  arguments: { path: 'README.md' },
                },
              ],
              interjections: [],
            }
          : undefined,
    })
    const parent = sessionFixture({
      id: 'session:agent-parent' as SessionId,
      lastSeq: 0,
    })
    const otherParent = sessionFixture({
      id: 'session:agent-other-parent' as SessionId,
      title: 'Other parent',
      lastSeq: 0,
    })
    const child = sessionFixture({
      id: 'session:agent-child' as SessionId,
      title: 'Subagent: review-worker',
      lifecycle: 'active',
      permissionMode: 'readonly',
      lastSeq: 4,
    })
    const older = execution({
      id: 'subagent:older',
      parentSessionId: parent.id,
      createdAt: FIXTURE_TIMESTAMP,
    })
    const newer = execution({
      id: 'subagent:newer',
      parentSessionId: parent.id,
      createdAt: '2026-07-22T00:01:00.000Z',
      status: 'failed',
    })
    newer.result = undefined
    newer.error = { code: 'SUBAGENT_FAILED', message: 'fixture failure' }

    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, projectFixture())
        sessions.insert(transaction, parent)
        sessions.insert(transaction, otherParent)
        subagents.insert(transaction, older)
        subagents.insert(transaction, newer)
        sessions.insert(transaction, child)
        subagents.attachSession(transaction, {
          sessionId: child.id,
          executionId: older.id,
          parentSessionId: parent.id,
          createdAt: FIXTURE_TIMESTAMP,
        })
        messages.insertMany(transaction, messageFixtures(child.id))
      })

      const first = await service.list({
        parentSessionId: parent.id,
        limit: 1,
      })
      expect(first).toMatchObject({
        hasMore: true,
        records: [
          {
            id: newer.id,
            status: 'failed',
            name: 'Subagent',
            error: { code: 'SUBAGENT_FAILED' },
          },
        ],
      })
      expect(JSON.stringify(first)).not.toContain('private.invalid')

      const second = await service.list({
        parentSessionId: parent.id,
        before: first.nextBefore,
        limit: 1,
      })
      expect(second).toMatchObject({
        hasMore: false,
        records: [{ id: older.id, name: 'review-worker' }],
      })

      const detail = await service.get({
        parentSessionId: parent.id,
        executionId: older.id,
        limit: 3,
      })
      expect(detail.task).toBe('visible search needle')
      expect(detail.statistics).toEqual({ toolCallCount: 1 })
      expect(detail.activityPage).toMatchObject({
        hasMore: true,
        records: [
          { type: 'reasoning', text: 'Use the file tool.' },
          { type: 'message', text: 'Reading the requested file' },
          { type: 'tool', tool: 'read_file', status: 'completed' },
          { type: 'message', text: 'Final visible answer' },
        ],
      })
      expect(JSON.stringify(detail)).not.toContain('reasoning-v1')
      expect(detail.live).toMatchObject({
        status: 'calling_llm',
        text: 'Current live output',
        reasoning: 'Current live reasoning',
        tools: [
          {
            tool: 'read_file',
            status: 'proposed',
            args: { path: 'README.md' },
          },
        ],
      })
      expect(JSON.stringify(detail.live)).not.toContain(child.id)
      expect(JSON.stringify(detail.live)).not.toContain('run:agent-child-live')

      await expect(
        service.get({
          parentSessionId: otherParent.id,
          executionId: older.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        service.list({ parentSessionId: child.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await testDatabase.dispose()
    }
  })
})
