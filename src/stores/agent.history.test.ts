// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import { conversationToMarkdown } from '../../shared/conversation-markdown'
import type { CallId } from '../../shared/ids'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import { useAgentStore } from './agent'
import {
  callId,
  installApi,
  markdownConversation,
  registerActiveSession,
  runId,
  sessionId,
  setupAgentTest,
  stamp,
} from './agent-test-support'

describe('agent store history and recovery', () => {
  setupAgentTest()

  it('auto-titles the conversation from the first user message', async () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.privacy.providerNoticeAccepted = {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-22T00:00:00.000Z',
    }
    const createSession = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { sessionId },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    installApi({ createSession, startRun })
    const store = useAgentStore()
    store.bridgeAvailable = true
    store.applyConfig(config)
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    store.input = 'Fix the flaky terminal test'

    await store.sendMessage()

    expect(store.activeConversation?.title).toBe('Fix the flaky terminal test')
  })

  it('approves an awaiting plan and starts a run', async () => {
    const plan = {
      id: 'plan:test',
      objective: 'Review this plan',
      status: 'awaiting_review' as const,
      items: [
        {
          id: 'item:1',
          title: 'Inspect state',
          status: 'pending' as const,
          updatedAt: stamp,
        },
      ],
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    const updatePlanStatus = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true, plan: { ...plan, status: 'active' as const } },
    }))
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    installApi({ updatePlanStatus, startRun })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    registerActiveSession(store)
    store.plan = plan

    await store.approvePlan()

    expect(updatePlanStatus).toHaveBeenCalledWith({
      version: 1,
      sessionId,
      status: 'active',
    })
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        sessionId,
        message: '用户已批准当前计划。继续执行已激活的计划。',
      }),
    )
    expect(store.plan?.status).toBe('active')
    expect(store.activeRunId).toBe(runId)
    expect(store.messages.at(-1)?.text).toContain('用户已批准当前计划')
  })

  it('forks a conversation into a new branch, truncating tools after the fork point', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.title = 'Original conversation'
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
      { id: 'm3', role: 'user', text: 'three', reasoning: '', order: 4 },
      { id: 'm4', role: 'assistant', text: 'four', reasoning: '', order: 5 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
      {
        callId: 'call-after' as CallId,
        runId,
        tool: 'create_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 6,
      },
    ]

    const result = await store.forkConversation(original.id, 'm2')

    expect(result).toBe(true)
    const forked = store.activeConversation
    expect(forked).toBeDefined()
    expect(forked?.id).not.toBe(original.id)
    expect(forked?.parentId).toBe(original.id)
    expect(forked?.parentTitle).toBe('Original conversation')
    expect(forked?.forkedAt).toBeDefined()
    // The fork keeps messages up to and including the fork point.
    expect(forked?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Tools recorded after the fork point are dropped; only the earlier one is kept.
    expect(forked?.tools?.map((tool) => tool.callId)).toEqual([callId])
    // The original conversation is untouched.
    expect(
      store.conversations.find((c) => c.id === original.id)?.messages,
    ).toHaveLength(4)
  })

  it('forks at the latest message without dropping timeline state', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
    ]
    original.usage = [
      {
        runId,
        callId,
        order: 3,
        usage: {
          scope: 'main',
          providerId: 'deepseek',
          providerLabel: 'DeepSeek',
          model: 'deepseek-v4-pro',
          contextWindowTokens: 64_000,
          contextWindowSource: 'default',
          raw: null,
        },
      },
    ]
    original.goal = {
      id: 'goal:one',
      objective: 'Finish the review',
      status: 'active',
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    original.plan = {
      id: 'plan:one',
      objective: 'Finish the review',
      items: [
        {
          id: 'item:one',
          title: 'Run checks',
          status: 'completed',
          updatedAt: stamp,
          result: 'done',
          evidence: 'unit test',
        },
      ],
      createdAt: stamp,
      updatedAt: stamp,
      continuationCount: 0,
    }
    original.orchestratorEntries = [
      {
        id: 'orchestrator:one',
        kind: 'goal-continuation',
        text: 'continue',
        createdAt: stamp,
        order: 4,
      },
    ]
    original.latestReviewedApproval = {
      runId,
      callId,
      tool: 'create_file',
      reason: 'Review diff',
      diff: '--- a/file\n+++ b/file',
      decision: 'allowed',
    }

    const result = await store.forkConversation(original.id, 'm2')

    expect(result).toBe(true)
    const forked = store.activeConversation
    expect(forked?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(forked?.tools).toHaveLength(1)
    expect(forked?.usage).toHaveLength(1)
    expect(forked?.orchestratorEntries).toHaveLength(1)
    expect(forked?.goal).toEqual(original.goal)
    expect(forked?.plan).toEqual(original.plan)
    expect(forked?.latestReviewedApproval).toEqual(
      original.latestReviewedApproval,
    )
  })

  it('reverts in place by discarding messages after the kept reply', async () => {
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const original = store.createConversation()
    if (!original) throw new Error('Expected conversation')
    original.messages = [
      { id: 'm1', role: 'user', text: 'one', reasoning: '', order: 0 },
      { id: 'm2', role: 'assistant', text: 'two', reasoning: '', order: 1 },
      { id: 'm3', role: 'user', text: 'three', reasoning: '', order: 4 },
      { id: 'm4', role: 'assistant', text: 'four', reasoning: '', order: 5 },
    ]
    original.tools = [
      {
        callId,
        runId,
        tool: 'read_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 2,
      },
      {
        callId: 'call-after' as CallId,
        runId,
        tool: 'create_file',
        args: {},
        reason: '',
        status: 'completed',
        order: 6,
      },
    ]

    const result = await store.revertConversationAfterMessage('m2')

    expect(result).toBe(true)
    // No new conversation is created; the same conversation is mutated in place.
    expect(store.conversations).toHaveLength(1)
    const reverted = store.activeConversation
    expect(reverted?.id).toBe(original.id)
    // The kept reply (m2) and everything before it remain; m3/m4 are gone.
    expect(reverted?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Tools recorded after the kept reply are also removed.
    expect(reverted?.tools?.map((tool) => tool.callId)).toEqual([callId])
  })

  it('imports markdown into the current workspace instead of trusting projectPath', async () => {
    const trustedWorkspace = 'F:/workspace/trusted'
    const markdown = conversationToMarkdown(
      markdownConversation({
        projectPath: 'C:/Users/alice/sensitive',
        title: 'External path import',
      }),
    )
    const importConversationMarkdown = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { canceled: false, markdown },
    }))
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ importConversationMarkdown, saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = trustedWorkspace

    const result = await store.importConversationViaDialog()

    expect(result).toMatchObject({ canceled: false })
    expect(store.activeConversation?.projectPath).toBe(trustedWorkspace)
    expect(store.projects.map((project) => project.path)).toEqual([
      trustedWorkspace,
    ])
    expect(
      store.projects.some(
        (project) => project.path === 'C:/Users/alice/sensitive',
      ),
    ).toBe(false)
    expect(saveWorkbench).toHaveBeenCalledTimes(1)
    expect(
      saveWorkbench.mock.calls[0]?.[0].workbench.conversations[0]?.projectPath,
    ).toBe(trustedWorkspace)
  })

  it('rejects schema-invalid imported markdown before mutating state', async () => {
    const markdown = conversationToMarkdown(
      markdownConversation({
        messages: [
          {
            id: 'message:too-large',
            role: 'user',
            text: 'x'.repeat(1_000_001),
            reasoning: '',
            order: 0,
          },
        ],
      }),
    )
    const importConversationMarkdown = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { canceled: false, markdown },
    }))
    const saveWorkbench = vi.fn(
      async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: payload.workbench,
      }),
    )
    installApi({ importConversationMarkdown, saveWorkbench })
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/trusted'

    const result = await store.importConversationViaDialog()

    expect(result.canceled).toBe(false)
    expect(result.error).toContain('/messages/0/text')
    expect(store.conversations).toHaveLength(0)
    expect(store.projects).toHaveLength(0)
    expect(saveWorkbench).not.toHaveBeenCalled()
  })
})
