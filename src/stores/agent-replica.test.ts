// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import { delay } from '../../shared/async/delay'
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
    titleSource: 'user',
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

function otherSession(id: number): SessionRecord {
  return {
    ...session(),
    id: `session:replica-${id.toString().padStart(3, '0')}` as SessionId,
    title: `Replica session ${id}`,
    updatedAt: new Date(Date.parse(timestamp) - id * 1_000).toISOString(),
  }
}

function numberedMessage(seq: number): MessageRecord {
  const messageId = `message:replica-${seq}` as MessageId
  return {
    ...userMessage,
    id: messageId,
    seq,
    turnId: messageId,
    clientRequestId: `request:replica-${seq}`,
    parts: [{ type: 'text', text: `message ${seq}` }],
  } as MessageRecord
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
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
        sessionPage: {
          schemaVersion: 1 as const,
          records: [session()],
          hasMore: false as const,
        },
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
        sessionPage: {
          schemaVersion: 1 as const,
          records: [session()],
          hasMore: false as const,
        },
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

  it('removes a deleted Session and every associated replica cache', async () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.sessions = [session()]
    replica.selectedProjectId = projectId
    replica.selectedSessionId = sessionId
    replica.messagesBySessionId[sessionId] = [userMessage]
    replica.runtimeBySessionId[sessionId] = undefined
    replica.traceCaptureBySessionId[sessionId] = undefined
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:replica',
      sequence: 1,
    }

    await replica.reconcile({
      schemaVersion: 1,
      cursor: {
        schemaVersion: 1,
        backendInstanceId: 'backend:replica',
        sequence: 2,
      },
      topic: 'session.removed',
      change: { sessionId, projectId },
    })

    expect(replica.sessions).toEqual([])
    expect(replica.selectedSessionId).toBeUndefined()
    expect(replica.messagesBySessionId).toEqual({})
  })

  it('loads the latest active Session when a removed current Project falls back outside the cache', async () => {
    const fallbackProjectId = 'project:replica-fallback' as ProjectId
    const fallbackSessionId = 'session:replica-fallback' as SessionId
    const fallbackProject: ProjectRecord = {
      ...project,
      id: fallbackProjectId,
      path: 'F:/workspace/replica-fallback',
      name: 'replica-fallback',
    }
    const fallbackSession: SessionRecord = {
      ...session(),
      id: fallbackSessionId,
      projectId: fallbackProjectId,
      title: 'Fallback session',
    }
    const listSessions = vi.fn(async () =>
      success({
        version: 1 as const,
        page: {
          schemaVersion: 1 as const,
          records: [fallbackSession],
          hasMore: false as const,
        },
      }),
    )
    const getSession = vi.fn(async () =>
      success({
        version: 1 as const,
        snapshot: {
          schemaVersion: 1 as const,
          session: fallbackSession,
          messagePage: {
            schemaVersion: 1 as const,
            sessionId: fallbackSessionId,
            records: [],
            hasMore: false as const,
          },
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { listSessions, getSession } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [project, fallbackProject]
    replica.sessions = [session()]
    replica.selectedProjectId = projectId
    replica.selectedSessionId = sessionId
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:replica',
      sequence: 1,
    }

    await replica.reconcile({
      schemaVersion: 1,
      cursor: {
        schemaVersion: 1,
        backendInstanceId: 'backend:replica',
        sequence: 2,
      },
      topic: 'project.changed',
      change: { projects: [fallbackProject] },
    })

    expect(listSessions).toHaveBeenCalledWith({
      version: 1,
      projectId: fallbackProjectId,
      lifecycle: 'active',
      limit: 1,
    })
    expect(getSession).toHaveBeenCalledWith({
      version: 1,
      sessionId: fallbackSessionId,
    })
    expect(replica.selectedProjectId).toBe(fallbackProjectId)
    expect(replica.selectedSessionId).toBe(fallbackSessionId)
  })

  it('coalesces bootstrap replay and loads the 201st active Session', async () => {
    const pending = delay(10).then(() =>
      success({
        version: 1 as const,
        cursor: {
          schemaVersion: 1 as const,
          backendInstanceId: 'backend:replica',
          sequence: 1,
        },
        projects: [project],
        sessionPage: {
          schemaVersion: 1 as const,
          records: Array.from({ length: 200 }, (_, index) =>
            otherSession(index + 1),
          ),
          hasMore: true as const,
          nextBefore: {
            updatedAt: otherSession(200).updatedAt,
            sessionId: otherSession(200).id,
          },
        },
      }),
    )
    const getBootstrap = vi.fn(async () => pending)
    const listSessions = vi.fn(async () =>
      success({
        version: 1 as const,
        page: {
          schemaVersion: 1 as const,
          records: [otherSession(201)],
          hasMore: false as const,
        },
      }),
    )
    const getSession = vi.fn(
      async ({ sessionId: target }: { sessionId: SessionId }) =>
        success({
          version: 1 as const,
          snapshot: {
            schemaVersion: 1 as const,
            session: otherSession(
              Number.parseInt(target.split('-').at(-1) ?? '1', 10),
            ),
            messagePage: {
              schemaVersion: 1 as const,
              sessionId: target,
              records: [],
              hasMore: false as const,
            },
          },
        }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getBootstrap,
        getSession,
        listSessions,
      } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()

    const first = replica.bootstrap()
    const second = replica.bootstrap()
    await Promise.all([first, second])

    expect(getBootstrap).toHaveBeenCalledTimes(1)
    expect(replica.sessions).toHaveLength(200)
    expect(await replica.loadOlderSessions()).toBe(true)
    expect(replica.sessions).toHaveLength(201)
    expect(
      replica.sessions.some((record) => record.id === otherSession(201).id),
    ).toBe(true)
  })

  it('preserves an active selected Session outside the bootstrap page', async () => {
    const getBootstrap = vi.fn(async () =>
      success({
        version: 1 as const,
        cursor: {
          schemaVersion: 1 as const,
          backendInstanceId: 'backend:replica',
          sequence: 2,
        },
        projects: [project],
        sessionPage: {
          schemaVersion: 1 as const,
          records: [otherSession(1)],
          hasMore: true as const,
          nextBefore: {
            updatedAt: otherSession(1).updatedAt,
            sessionId: otherSession(1).id,
          },
        },
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
    replica.projects = [project]
    replica.sessions = [session()]
    replica.selectedProjectId = projectId
    replica.selectedSessionId = sessionId

    await expect(replica.bootstrap()).resolves.toBe(true)

    expect(getSession).toHaveBeenCalledWith({ version: 1, sessionId })
    expect(replica.selectedSessionId).toBe(sessionId)
    expect(replica.sessions.some((record) => record.id === sessionId)).toBe(
      true,
    )
  })

  it('ignores a stale search response and can select an uncached Session', async () => {
    const oldSearch =
      deferred<Awaited<ReturnType<AgentApi['searchSessions']>>>()
    const newSearch =
      deferred<Awaited<ReturnType<AgentApi['searchSessions']>>>()
    const searchSessions = vi.fn(async ({ text }: { text: string }) =>
      text === 'old' ? oldSearch.promise : newSearch.promise,
    )
    const uncached = otherSession(300)
    const getSession = vi.fn(async () =>
      success({
        version: 1 as const,
        snapshot: {
          schemaVersion: 1 as const,
          session: uncached,
          messagePage: {
            schemaVersion: 1 as const,
            sessionId: uncached.id,
            records: [],
            hasMore: false as const,
          },
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        searchSessions,
        getSession,
      } as Partial<AgentApi> as AgentApi,
    })
    const replica = useAgentReplicaStore()
    replica.projects = [project]

    const oldRequest = replica.search('old')
    const newRequest = replica.search('new')
    newSearch.resolve(
      success({
        version: 1 as const,
        hits: [
          {
            session: otherSession(2),
            match: { kind: 'title' as const, snippet: 'new' },
          },
        ],
      }),
    )
    await newRequest
    oldSearch.resolve(
      success({
        version: 1 as const,
        hits: [
          {
            session: otherSession(1),
            match: { kind: 'title' as const, snippet: 'old' },
          },
        ],
      }),
    )
    await oldRequest

    expect(replica.searchHits.map((hit) => hit.match.snippet)).toEqual(['new'])
    expect(
      replica.sessions.some((record) => record.id === otherSession(2).id),
    ).toBe(true)
    expect(await replica.selectSession(uncached.id)).toBe(true)
    expect(getSession).toHaveBeenCalled()
    expect(replica.selectedSessionId).toBe(uncached.id)
  })

  it('loads the 201st Message from a stable cursor', async () => {
    const replica = useAgentReplicaStore()
    replica.projects = [project]
    replica.sessions = [session()]
    replica.selectedProjectId = projectId
    replica.selectedSessionId = sessionId
    replica.messagesBySessionId[sessionId] = Array.from(
      { length: 200 },
      (_, index) => numberedMessage(index + 2),
    )
    replica.messageHasMoreBySessionId[sessionId] = true
    replica.messageNextBeforeSeqBySessionId[sessionId] = 2
    const listMessages = vi.fn(async () =>
      success({
        version: 1 as const,
        page: {
          schemaVersion: 1 as const,
          sessionId,
          records: [numberedMessage(1)],
          hasMore: false as const,
        },
      }),
    )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { listMessages } as unknown as AgentApi,
    })
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:replica',
      sequence: 1,
    }

    expect(await replica.loadOlderMessages()).toBe(true)
    expect(replica.selectedMessages).toHaveLength(201)
    expect(replica.selectedMessages[0]?.seq).toBe(1)
  })
})
