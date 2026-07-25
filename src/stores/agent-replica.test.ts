// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type {
  DurableCommitEnvelope,
  SessionCommitEnvelopeSchema,
} from '../../shared/domain-state-api'
import type { MessageId, ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { SessionRecord } from '../../shared/session'
import type { Static } from '@sinclair/typebox'
import { useAgentReplicaStore } from './agent-replica'

const projectId = 'project:replica' as ProjectId
const sessionId = 'session:replica' as SessionId
const timestamp = '2026-07-25T00:00:00.000Z'

const project: ProjectRecord = {
  schemaVersion: 1,
  id: projectId,
  path: 'F:/workspace/replica',
  name: 'replica',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}

function session(revision = 1): SessionRecord {
  return {
    schemaVersion: 1,
    id: sessionId,
    projectId,
    title: 'Replica session',
    lifecycle: 'active',
    permissionMode: 'readonly',
    modelSelection: {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'off',
    },
    goal: null,
    plan: null,
    revision,
    lastSeq: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

const userMessage: MessageRecord = {
  schemaVersion: 1,
  id: 'message:replica-user' as MessageId,
  sessionId,
  seq: 1,
  visibility: 'visible',
  turnId: 'message:replica-user' as MessageId,
  inHistory: true,
  createdAt: timestamp,
  kind: 'user_input',
  clientRequestId: 'request:replica-user',
  parts: [{ type: 'text', text: 'durable user message' }],
  metadata: {
    schemaVersion: 1,
    submission: { type: 'message' },
  },
}

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

function sessionCommit(
  sequence: number,
  revision: number,
): Static<typeof SessionCommitEnvelopeSchema> {
  return {
    schemaVersion: 1,
    cursor: {
      schemaVersion: 1,
      backendInstanceId: 'backend:replica',
      sequence,
    },
    topic: 'session.changed',
    change: {
      session: session(revision),
      messageChange: { mode: 'upsert', records: [userMessage] },
    },
  }
}

describe('agent durable replica', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('deduplicates commits and reboots on a cursor gap', async () => {
    const getBootstrap = vi.fn(async () =>
      success({
        version: 1 as const,
        cursor: {
          schemaVersion: 1 as const,
          backendInstanceId: 'backend:replica',
          sequence: 1,
        },
        projects: [project],
        sessions: [session()],
      }),
    )
    const getSession = vi.fn(async () =>
      success({
        version: 1 as const,
        snapshot: {
          schemaVersion: 1 as const,
          session: session(),
          messagePage: {
            schemaVersion: 1 as const,
            sessionId,
            records: [],
            hasMore: false as const,
          },
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { getBootstrap, getSession } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()

    await replica.bootstrap()
    const commit = sessionCommit(2, 2)
    await replica.reconcile(commit)
    await replica.reconcile(commit)
    expect(replica.messagesBySessionId[sessionId]).toEqual([userMessage])

    await replica.reconcile({
      ...sessionCommit(4, 3),
    } as DurableCommitEnvelope)
    expect(getBootstrap).toHaveBeenCalledTimes(2)
  })

  it('reloads a Session snapshot when its revision jumps', async () => {
    const getBootstrap = vi.fn(async () =>
      success({
        version: 1 as const,
        cursor: {
          schemaVersion: 1 as const,
          backendInstanceId: 'backend:replica',
          sequence: 1,
        },
        projects: [project],
        sessions: [session()],
      }),
    )
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(
        success({
          version: 1 as const,
          snapshot: {
            schemaVersion: 1 as const,
            session: session(),
            messagePage: {
              schemaVersion: 1 as const,
              sessionId,
              records: [],
              hasMore: false as const,
            },
          },
        }),
      )
      .mockResolvedValue(
        success({
          version: 1 as const,
          snapshot: {
            schemaVersion: 1 as const,
            session: session(4),
            messagePage: {
              schemaVersion: 1 as const,
              sessionId,
              records: [userMessage],
              hasMore: false as const,
            },
          },
        }),
      )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { getBootstrap, getSession } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    await replica.bootstrap()
    getSession.mockClear()

    await replica.reconcile(sessionCommit(2, 4))

    expect(getSession).toHaveBeenCalledWith({ version: 1, sessionId })
    expect(replica.selectedSession?.revision).toBe(4)
    expect(replica.selectedMessages).toEqual([userMessage])
  })
})
