// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import type { RunId, SessionId } from '../../shared/ids'
import { useAgentStore } from './agent'
import { useAgentRuntimeStore } from './agent-runtime'
import {
  installApi,
  registerActiveSession,
  runId,
  sessionId,
  setupAgentTest,
  stamp,
} from './agent-test-support'

describe('agent store conversation selection', () => {
  setupAgentTest()

  it('does not change conversation recency when merely switching', async () => {
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const first = store.createConversation()
    const second = store.createConversation()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (!first || !second) return

    first.updatedAt = '2026-06-20T00:00:00.000Z'
    second.updatedAt = '2026-06-20T00:01:00.000Z'

    await store.selectConversation(first.id)

    expect(second.updatedAt).toBe('2026-06-20T00:01:00.000Z')
    expect(store.activeConversationId).toBe(first.id)
  })

  it('allows switching away from a conversation with an active background run', async () => {
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.workspacePath = 'F:/workspace/example'
    const first = store.createConversation()
    const second = store.createConversation()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (!first || !second) return

    store.activeConversationId = first.id
    store.restoreActiveConversation()
    const firstRuntime = runtime.ensureConversationRuntime(first.id)
    firstRuntime.sessionId = sessionId
    firstRuntime.activeRunId = runId
    firstRuntime.runStatus = 'calling_llm'
    runtime.registerSession(first.id, sessionId)

    await expect(store.selectConversation(second.id)).resolves.toBe(true)

    expect(store.activeConversationId).toBe(second.id)
    expect(store.activeRunId).toBeUndefined()
    expect(runtime.conversationRuntimes[first.id]?.activeRunId).toBe(runId)
  })

  it('routes background session events to their conversation record', () => {
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.workspacePath = 'F:/workspace/example'
    const background = store.createConversation()
    const foreground = store.createConversation()
    expect(background).toBeDefined()
    expect(foreground).toBeDefined()
    if (!background || !foreground) return

    const backgroundSessionId = 'session:background' as SessionId
    const backgroundRunId = 'run:background' as RunId
    const backgroundRuntime = runtime.ensureConversationRuntime(background.id)
    backgroundRuntime.sessionId = backgroundSessionId
    runtime.registerSession(background.id, backgroundSessionId)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'assistant.text.delta',
      sessionId: backgroundSessionId,
      runId: backgroundRunId,
      delta: 'background text',
    })

    expect(store.activeConversationId).toBe(foreground.id)
    expect(store.messages).toEqual([])
    expect(background.messages[0]).toMatchObject({
      role: 'assistant',
      runId: backgroundRunId,
      text: 'background text',
    })
  })

  it('publishes a new renderer workspace only after main-process config switches', async () => {
    const firstWorkspace = 'F:/workspace/first'
    const secondWorkspace = 'F:/workspace/second'
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    config.workspace.lastOpened = secondWorkspace
    let resolveSetConfig!: (
      value: Awaited<ReturnType<AgentApi['setConfig']>>,
    ) => void
    const setConfig = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<AgentApi['setConfig']>>>((resolve) => {
          resolveSetConfig = resolve
        }),
    )
    installApi({ setConfig })
    const store = useAgentStore()
    store.workspacePath = firstWorkspace
    const first = store.createConversation(firstWorkspace)
    const second = store.createConversation(secondWorkspace)
    if (!first || !second) throw new Error('Expected conversations')
    store.activeConversationId = first.id
    store.restoreActiveConversation()

    const switching = store.selectConversation(second.id)
    await Promise.resolve()

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'workspace',
      lastOpened: secondWorkspace,
    })
    expect(store.workspacePath).toBe(firstWorkspace)

    resolveSetConfig({
      version: 1,
      ok: true,
      value: { config },
    })
    await expect(switching).resolves.toBe(true)
    expect(store.workspacePath).toBe(secondWorkspace)
    expect(store.activeConversationId).toBe(second.id)
  })

  it('creates a new conversation for a specific project workspace', async () => {
    const firstWorkspace = 'F:/workspace/first'
    const secondWorkspace = 'F:/workspace/second'
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    config.workspace.lastOpened = secondWorkspace
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config },
    }))
    installApi({ setConfig })
    const store = useAgentStore()
    store.workspacePath = firstWorkspace
    store.registerProject(firstWorkspace)
    store.registerProject(secondWorkspace)

    await expect(store.newConversation(secondWorkspace)).resolves.toBe(true)

    expect(setConfig).toHaveBeenCalledWith({
      version: 1,
      kind: 'workspace',
      lastOpened: secondWorkspace,
    })
    expect(store.workspacePath).toBe(secondWorkspace)
    expect(store.activeConversation?.projectPath).toBe(secondWorkspace)
  })

  it('ignores duplicate Agent events and reports sequence gaps', () => {
    const store = useAgentStore()
    registerActiveSession(store)
    const first = {
      schemaVersion: 1 as const,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta' as const,
      sessionId,
      runId,
      delta: 'one',
    }

    store.handleAgentEvent(first)
    store.handleAgentEvent(first)
    store.handleAgentEvent({ ...first, seq: 3, delta: 'three' })

    expect(store.messages[0]?.text).toBe('onethree')
    expect(store.agentEventGap).toContain('expected 2, received 3')
  })

  it('accepts a fresh event sequence after replacing a conversation session', () => {
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const conversation = store.createConversation()
    expect(conversation).toBeDefined()
    if (!conversation) return

    const firstSession = 'session:first-sequence' as SessionId
    const replacementSession = 'session:replacement-sequence' as SessionId
    store.registerSession(conversation.id, firstSession)
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'assistant.text.delta',
      sessionId: firstSession,
      runId,
      delta: 'first session output',
    })

    store.registerSession(conversation.id, replacementSession)
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'assistant.text.delta',
      sessionId: replacementSession,
      runId: 'run:replacement-sequence' as RunId,
      delta: 'replacement session output',
    })

    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'replacement session output' }),
      ]),
    )
  })

  it('keeps composer drafts and context attachments isolated across conversation switches', async () => {
    const store = useAgentStore()
    store.workspacePath = 'F:/workspace/example'
    const first = store.createConversation()
    const second = store.createConversation()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (!first || !second) return

    store.activeConversationId = first.id
    store.restoreActiveConversation()
    store.input = 'Keep this draft in the first conversation'
    store.addContextAttachments([
      { kind: 'file', path: 'src/main.ts', source: 'picker' },
    ])

    await expect(store.selectConversation(second.id)).resolves.toBe(true)
    store.input = 'Keep this draft in the second conversation'
    store.addContextAttachments([
      { kind: 'file', path: 'src/other.ts', source: 'picker' },
    ])
    await expect(store.selectConversation(first.id)).resolves.toBe(true)

    expect({
      input: store.input,
      contextAttachments: store.contextAttachments,
    }).toEqual({
      input: 'Keep this draft in the first conversation',
      contextAttachments: [
        { kind: 'file', path: 'src/main.ts', source: 'picker' },
      ],
    })
  })
})
