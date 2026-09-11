// @vitest-environment jsdom

import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { DurableRunStartPayload } from '../../shared/domain-state-api'
import type { MessageId, ProjectId, RunId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import { useAgentStore } from './agent'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useProviderSettingsStore } from './agent-settings'
import { useModelRolesStore } from './model-roles'
import { composerDraftKey, useComposerDraftsStore } from './composer-drafts'
import {
  restoreComposerDraftView,
  trackComposerDraftView,
} from './composer-draft-view'

const projectId = 'project:drafts' as ProjectId
const a = 'session:a' as SessionId
const b = 'session:b' as SessionId
const attachment = {
  kind: 'file' as const,
  source: 'picker' as const,
  path: 'notes.md',
}
const timestamp = '2026-09-11T00:00:00.000Z'
let pinia: Pinia

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}
function failure() {
  return {
    version: 1 as const,
    ok: false as const,
    error: { code: 'CONFLICT' as const, message: 'Not accepted' },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
function session(id: SessionId): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    title: id,
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
    revision: 1,
    lastSeq: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
function message(
  sessionId: SessionId,
): Extract<MessageRecord, { kind: 'user_input' }> {
  return {
    schemaVersion: 1,
    id: 'message:user' as MessageId,
    sessionId,
    seq: 1,
    turnId: 'message:user' as MessageId,
    visibility: 'visible',
    inHistory: true,
    createdAt: timestamp,
    kind: 'user_input',
    clientRequestId: 'request:user',
    parts: [{ type: 'text', text: 'original message' }],
    metadata: {
      schemaVersion: 1,
      submission: { type: 'message' },
      attachments: [attachment],
    },
  }
}
function startResult(id: SessionId) {
  return success({
    version: 1 as const,
    outcome: 'deduplicated' as const,
    session: session(id),
    userMessage: message(id),
  })
}
function installApi(overrides: Partial<AgentApi> = {}) {
  const getSession = vi.fn(async ({ sessionId }: { sessionId: SessionId }) =>
    success({
      version: 1 as const,
      snapshot: {
        schemaVersion: 1 as const,
        session: session(sessionId),
        messagePage: {
          schemaVersion: 1 as const,
          sessionId,
          records: [message(sessionId)],
          hasMore: false as const,
        },
      },
    }),
  )
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: {
      getSession,
      listAgentExecutions: async () =>
        success({ page: { schemaVersion: 1, records: [], hasMore: false } }),
      ...overrides,
    } as AgentApi,
  })
  return getSession
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  const replica = useAgentReplicaStore()
  replica.projects = [
    {
      schemaVersion: 1,
      id: projectId,
      name: 'Draft project',
      path: 'D:/workspace/drafts',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]
  replica.sessions = [session(a), session(b)]
  replica.selectedProjectId = projectId
  replica.selectedSessionId = a
  replica.messagesBySessionId[a] = [message(a)]
  useProviderSettingsStore().providers = [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      providerType: 'generic.chat-completions',
      revision: 1,
      baseURL: 'https://provider.invalid/v1',
      model: 'deepseek-chat',
      modelCatalog: [{ id: 'deepseek-chat' }],
      enabledModelIds: ['deepseek-chat'],
      modelOverrides: {},
      credentialConfigured: true,
      credentialSource: 'safe-storage',
    },
  ]
  useModelRolesStore().defaultModelProvider = 'deepseek'
  useModelRolesStore().defaultModel = 'deepseek-chat'
  installApi()
})
afterEach(() => {
  disposePinia(pinia)
  vi.restoreAllMocks()
})

describe('composer action ownership', () => {
  it('keeps text outside runtime state and restores it after selection and hydration', async () => {
    const agent = useAgentStore()
    agent.input = 'draft A'
    agent.addContextAttachments([attachment])
    await agent.selectConversation(b)
    expect(agent.input).toBe('')
    agent.input = 'draft B'
    await agent.selectConversation(a)
    useAgentRuntimeStore().hydrateRuntime({
      schemaVersion: 1,
      sessionId: a,
      runId: 'run:a' as RunId,
      status: 'calling_llm',
      text: 'stream',
      reasoning: 'CoT',
      tools: [],
      interjections: [],
    })
    expect(agent.input).toBe('draft A')
    expect(agent.contextAttachments).toEqual([attachment])
    expect(useAgentRuntimeStore().$state).not.toHaveProperty('input')
  })

  it('clears only the submitted draft after switching to another Session', async () => {
    const pending = deferred<ReturnType<typeof startResult>>()
    installApi({ startRun: async () => pending.promise })
    const agent = useAgentStore()
    agent.input = 'send A'
    const sending = agent.sendMessage()
    await agent.selectConversation(b)
    agent.input = 'keep B'
    pending.resolve(startResult(a))
    expect(await sending).toBe(true)
    expect(agent.activeConversationId).toBe(b)
    expect(agent.input).toBe('keep B')
    await agent.selectConversation(a)
    expect(agent.input).toBe('')
  })

  it('preserves text and attachments edited while submission is pending', async () => {
    const pending = deferred<ReturnType<typeof startResult>>()
    const startRun = vi.fn(async (payload: DurableRunStartPayload) => {
      void payload
      return pending.promise
    })
    installApi({ startRun })
    const agent = useAgentStore()
    agent.input = 'submitted'
    const sending = agent.sendMessage()
    agent.input = 'next message'
    agent.addContextAttachments([attachment])
    pending.resolve(startResult(a))
    await sending
    expect(startRun.mock.calls[0]![0]).toMatchObject({
      message: 'submitted',
      context: { attachments: [] },
    })
    expect(agent.input).toBe('next message')
    expect(agent.contextAttachments).toEqual([attachment])
  })

  it('preserves a failed submission and programmatic submissions that retain the composer', async () => {
    const agent = useAgentStore()
    agent.input = 'user draft'
    agent.addContextAttachments([attachment])
    installApi({ startRun: async () => failure() })
    expect(await agent.sendMessage()).toBe(false)
    expect(agent.input).toBe('user draft')
    installApi({ startRun: async () => startResult(a) })
    expect(
      await agent.sendMessage({
        text: 'system follow-up',
        clearInput: false,
        includeContext: false,
      }),
    ).toBe(true)
    expect(agent.input).toBe('user draft')
    expect(agent.contextAttachments).toEqual([attachment])
  })

  it('moves continued typing from the project placeholder into its newly created Session', async () => {
    const pending = deferred<ReturnType<typeof startResult>>()
    let createdId!: SessionId
    installApi({
      startRun: async (payload) => {
        createdId = payload.sessionId
        return pending.promise
      },
    })
    const agent = useAgentStore()
    await agent.newConversation()
    agent.input = 'first message'
    const sending = agent.sendMessage()
    expect(await agent.sendMessage()).toBe(false)
    agent.input = 'second message'
    pending.resolve(startResult(createdId))
    await sending
    expect(agent.activeConversationId).toBe(createdId)
    expect(agent.input).toBe('second message')
    await agent.newConversation()
    expect(agent.input).toBe('')
  })

  it('does not take over a newly revisited placeholder after the user navigates', async () => {
    const pending = deferred<ReturnType<typeof startResult>>()
    let createdId!: SessionId
    installApi({
      startRun: async (payload) => {
        createdId = payload.sessionId
        return pending.promise
      },
    })
    const agent = useAgentStore()
    await agent.newConversation()
    agent.input = 'submitted'
    const sending = agent.sendMessage()
    await agent.newConversation()
    agent.input = 'separate new draft'
    pending.resolve(startResult(createdId))
    await sending
    expect(agent.activeConversationId).toBeUndefined()
    expect(agent.input).toBe('separate new draft')
  })

  it('isolates simultaneous new-session starts in different projects', async () => {
    const replica = useAgentReplicaStore()
    const otherProjectId = 'project:other' as ProjectId
    replica.projects.push({
      ...replica.projects[0]!,
      id: otherProjectId,
      path: 'D:/workspace/other',
    })
    const first = deferred<ReturnType<typeof startResult>>()
    const second = deferred<ReturnType<typeof startResult>>()
    const payloads: DurableRunStartPayload[] = []
    installApi({
      startRun: async (payload) => {
        payloads.push(payload)
        return payloads.length === 1 ? first.promise : second.promise
      },
    })
    const agent = useAgentStore()
    await agent.newConversation()
    agent.input = 'first project'
    const sendingFirst = agent.sendMessage()
    await agent.newConversation('D:/workspace/other')
    expect(agent.startPending).toBe(false)
    agent.input = 'second project'
    const sendingSecond = agent.sendMessage()
    expect(payloads).toHaveLength(2)
    first.resolve(startResult(payloads[0]!.sessionId))
    await sendingFirst
    expect(agent.selectedProjectId).toBe(otherProjectId)
    expect(agent.startPending).toBe(true)
    const result = startResult(payloads[1]!.sessionId)
    result.value.session.projectId = otherProjectId
    second.resolve(result)
    await sendingSecond
    expect(agent.selectedSessionId).toBe(payloads[1]!.sessionId)
    expect(agent.startPending).toBe(false)
    expect(agent.input).toBe('')
  })

  it.each([false, true])(
    'keeps text-only interjections scoped to their original draft (edited: %s)',
    async (edited) => {
      const pending = deferred<Awaited<ReturnType<AgentApi['interjectRun']>>>()
      installApi({ interjectRun: async () => pending.promise })
      const agent = useAgentStore()
      useAgentRuntimeStore().ensureOverlay(a).runId = 'run:a' as RunId
      agent.input = 'interjection'
      agent.addContextAttachments([attachment])
      const sending = agent.sendInterjection()
      if (edited) agent.input = 'next interjection'
      await agent.selectConversation(b)
      agent.input = 'B remains'
      pending.resolve(
        success({ accepted: true }) as Awaited<
          ReturnType<AgentApi['interjectRun']>
        >,
      )
      await sending
      expect(agent.input).toBe('B remains')
      await agent.selectConversation(a)
      expect(agent.input).toBe(edited ? 'next interjection' : '')
      expect(agent.contextAttachments).toEqual([attachment])
    },
  )

  it.each([false, true])(
    'restores an edited history message only to its unchanged owner (edited: %s)',
    async (edited) => {
      const runtime = useAgentRuntimeStore()
      const pending = deferred<boolean>()
      vi.spyOn(runtime, 'rewindMessage').mockImplementation(
        async () => pending.promise,
      )
      const agent = useAgentStore()
      const editing = agent.editUserMessage('message:user')
      if (edited) agent.input = 'typed while rewinding'
      await agent.selectConversation(b)
      agent.input = 'B draft'
      pending.resolve(true)
      await editing
      expect(agent.input).toBe('B draft')
      await agent.selectConversation(a)
      expect(agent.input).toBe(
        edited ? 'typed while rewinding' : 'original message',
      )
    },
  )

  it('puts an asynchronous attachment selection in its originating Session', async () => {
    const pending =
      deferred<Awaited<ReturnType<AgentApi['chooseWorkspaceContext']>>>()
    installApi({ chooseWorkspaceContext: async () => pending.promise })
    const agent = useAgentStore()
    const choosing = agent.chooseContextAttachment('file')
    await agent.selectConversation(b)
    pending.resolve(
      success({ attachments: [attachment] }) as Awaited<
        ReturnType<AgentApi['chooseWorkspaceContext']>
      >,
    )
    await choosing
    expect(agent.contextAttachments).toEqual([])
    await agent.selectConversation(a)
    expect(agent.contextAttachments).toEqual([attachment])
  })
})

describe('draft navigation and lifecycle', () => {
  it('flushes during switching and restores the last project placeholder', async () => {
    const replica = useAgentReplicaStore()
    const agent = useAgentStore()
    const stop = trackComposerDraftView(replica)
    agent.input = 'A draft'
    await agent.newConversation()
    agent.input = 'new draft'
    await nextTick()
    expect(
      localStorage.getItem(
        'composer-draft:' + composerDraftKey({ projectId, sessionId: a }),
      ),
    ).toContain('A draft')
    stop()
    replica.selectedSessionId = a
    await restoreComposerDraftView(replica)
    expect(replica.selectedSessionId).toBeUndefined()
    expect(agent.input).toBe('new draft')
  })

  it('loads a saved Session outside the first page without pruning its draft', async () => {
    const replica = useAgentReplicaStore()
    const drafts = useComposerDraftsStore()
    drafts.setText({ projectId, sessionId: b }, 'old Session draft')
    replica.sessions = [session(a)]
    replica.pruneCaches()
    localStorage.setItem(
      'composer-draft-view',
      JSON.stringify({ projectId, sessionId: b }),
    )
    await restoreComposerDraftView(replica)
    expect(replica.selectedSessionId).toBe(b)
    expect(useAgentStore().input).toBe('old Session draft')
  })

  it('preserves archived drafts and removes them only on confirmed deletion', async () => {
    const replica = useAgentReplicaStore()
    const drafts = useComposerDraftsStore()
    drafts.setText({ projectId, sessionId: b }, 'archived draft')
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:test',
      sequence: 1,
    }
    await replica.reconcile({
      schemaVersion: 1,
      cursor: { ...replica.cursor, sequence: 2 },
      topic: 'session.changed',
      change: {
        session: {
          ...session(b),
          lifecycle: 'archived',
          archivedAt: timestamp,
          revision: 2,
        },
        messageChange: { mode: 'none' },
      },
    })
    expect(drafts.get({ projectId, sessionId: b }).text).toBe('archived draft')
    await replica.reconcile({
      schemaVersion: 1,
      cursor: { ...replica.cursor!, sequence: 3 },
      topic: 'session.removed',
      change: { projectId, sessionId: b },
    })
    expect(drafts.get({ projectId, sessionId: b }).text).toBe('')
  })

  it('ignores a late uncached selection after starting a new conversation', async () => {
    const replica = useAgentReplicaStore()
    const pending = deferred<boolean>()
    vi.spyOn(replica, 'loadSession').mockImplementation(async () => {
      await pending.promise
      replica.sessions.push(session(b))
      return true
    })
    replica.sessions = [session(a)]
    const selecting = replica.selectSession(b)
    replica.beginDraft(projectId)
    pending.resolve(true)
    expect(await selecting).toBe(false)
    expect(replica.selectedSessionId).toBeUndefined()
  })

  it('does not replace a new draft with a late project-removal fallback', async () => {
    const replica = useAgentReplicaStore()
    const otherProjectId = 'project:other' as ProjectId
    const otherProject = {
      ...replica.projects[0]!,
      id: otherProjectId,
      path: 'D:/workspace/other',
    }
    replica.projects.push(otherProject)
    replica.sessions = [session(a)]
    replica.cursor = {
      schemaVersion: 1,
      backendInstanceId: 'backend:test',
      sequence: 0,
    }
    const pending = deferred<Awaited<ReturnType<AgentApi['listSessions']>>>()
    installApi({ listSessions: async () => pending.promise })
    const removal = replica.reconcile({
      schemaVersion: 1,
      cursor: { ...replica.cursor, sequence: 1 },
      topic: 'project.changed',
      change: { projects: [otherProject] },
    })
    const agent = useAgentStore()
    await agent.newConversation(otherProject.path)
    agent.input = 'new fallback project draft'
    pending.resolve(
      success({
        version: 1,
        page: {
          schemaVersion: 1,
          records: [{ ...session(b), projectId: otherProjectId }],
          hasMore: false,
        },
      }),
    )
    await removal
    expect(agent.selectedProjectId).toBe(otherProjectId)
    expect(agent.selectedSessionId).toBeUndefined()
    expect(agent.input).toBe('new fallback project draft')
  })
})
