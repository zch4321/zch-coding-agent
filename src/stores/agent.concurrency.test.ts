// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import type { SessionId } from '../../shared/ids'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import { useAgentStore } from './agent'
import { useAgentRuntimeStore } from './agent-runtime'
import {
  callId,
  installApi,
  runId,
  sessionId,
  setupAgentTest,
  stamp,
} from './agent-test-support'

describe('agent store workspace concurrency', () => {
  setupAgentTest()

  it('lazily locks only the selected conversation while a workspace writer is active', async () => {
    const workspace = 'F:/workspace/shared'
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.workspace.lastOpened = workspace
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config },
    }))
    const updateSessionMode = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true },
    }))
    installApi({ setConfig, updateSessionMode })
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.workspacePath = workspace
    const writer = store.createConversation(workspace)!
    const selected = store.createConversation(workspace)!
    const inactive = store.createConversation(workspace)!
    writer.mode = 'auto'
    selected.mode = 'confirm'
    inactive.mode = 'yolo'
    const writerSession = 'session:writer' as SessionId
    const selectedSession = 'session:selected' as SessionId
    runtime.registerSession(writer.id, writerSession)
    runtime.registerSession(selected.id, selectedSession)
    store.activeConversationId = writer.id
    store.restoreActiveConversation()

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'workspace.writer.changed',
      workspace,
      status: 'acquired',
      writerConversationId: writer.id,
      writerSessionId: writerSession,
      writerRunId: runId,
    })

    expect(selected.mode).toBe('confirm')
    expect(inactive.mode).toBe('yolo')
    await expect(store.selectConversation(selected.id)).resolves.toBe(true)
    expect(selected.mode).toBe('readonly')
    expect(inactive.mode).toBe('yolo')
    expect(store.mode).toBe('readonly')
    expect(store.modeLockedByWriter).toBe(true)
    expect(updateSessionMode).toHaveBeenCalledWith({
      version: 1,
      sessionId: selectedSession,
      mode: 'readonly',
    })

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: stamp,
      type: 'workspace.writer.changed',
      workspace,
      status: 'released',
      writerConversationId: writer.id,
      writerSessionId: writerSession,
      writerRunId: runId,
    })
    expect(store.modeLockedByWriter).toBe(false)
    expect(selected.mode).toBe('readonly')
  })

  it('keeps create-session and start-run results on their origin conversation', async () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.privacy.providerNoticeAccepted = {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: stamp,
    }
    config.workspace.lastOpened = 'F:/workspace/example'
    let resolveSession!: (
      value: Awaited<ReturnType<AgentApi['createSession']>>,
    ) => void
    const createSession = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<AgentApi['createSession']>>>(
          (resolve) => {
            resolveSession = resolve
          },
        ),
    )
    const startRun = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { runId },
    }))
    const setConfig = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { config },
    }))
    installApi({ createSession, startRun, setConfig })
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.bridgeAvailable = true
    store.applyConfig(config)
    store.workspacePath = 'F:/workspace/example'
    const origin = store.createConversation()!
    const foreground = store.createConversation()!
    store.activeConversationId = origin.id
    store.restoreActiveConversation()
    store.input = 'Message for A'

    const sending = store.sendMessage()
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    expect(runtime.conversationRuntimes[origin.id]?.startPending).toBe(true)

    await store.selectConversation(foreground.id)
    store.input = 'Draft for B'
    resolveSession({
      version: 1,
      ok: true,
      value: { sessionId },
    })
    await expect(sending).resolves.toBe(true)

    expect(store.activeConversationId).toBe(foreground.id)
    expect(store.input).toBe('Draft for B')
    expect(store.messages).toEqual([])
    expect(origin.messages.at(-1)?.text).toBe('Message for A')
    expect(runtime.conversationRuntimes[origin.id]).toMatchObject({
      sessionId,
      activeRunId: runId,
      startPending: false,
    })
    expect(
      runtime.conversationRuntimes[foreground.id]?.sessionId,
    ).toBeUndefined()
  })

  it('routes a background approval decision by explicit conversation id', async () => {
    const decideApproval = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { accepted: true },
    }))
    installApi({ decideApproval })
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.workspacePath = 'F:/workspace/example'
    const background = store.createConversation()!
    const foreground = store.createConversation()!
    const backgroundSession = 'session:background-approval' as SessionId
    runtime.registerSession(background.id, backgroundSession)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'approval.requested',
      sessionId: backgroundSession,
      runId,
      callId,
      kind: 'tool',
      tool: 'create_file',
      args: { path: 'note.txt', content: 'ok' },
      reason: 'Background write',
      policySignals: [],
      diff: 'diff',
      rememberable: false,
      expiresAt: stamp,
    })

    expect(store.activeConversationId).toBe(foreground.id)
    expect(store.pendingApproval).toBeUndefined()
    expect(store.conversationStatus(background.id)).toBe('awaitingApproval')
    await store.decideApproval({
      conversationId: background.id,
      decision: 'deny',
    })

    expect(decideApproval).toHaveBeenCalledWith({
      version: 1,
      sessionId: backgroundSession,
      runId,
      callId,
      decision: 'deny',
    })
    expect(
      runtime.conversationRuntimes[background.id]?.pendingApproval,
    ).toBeUndefined()
  })

  it('debounces background streaming persistence across conversations', async () => {
    vi.useFakeTimers()
    try {
      const saveWorkbench = vi.fn(
        async (payload: Parameters<AgentApi['saveWorkbench']>[0]) => ({
          version: 1 as const,
          ok: true as const,
          value: payload.workbench,
        }),
      )
      installApi({ saveWorkbench })
      const store = useAgentStore()
      const runtime = useAgentRuntimeStore()
      store.workspacePath = 'F:/workspace/example'
      const background = store.createConversation()!
      store.createConversation()
      const backgroundSession = 'session:background-save' as SessionId
      runtime.registerSession(background.id, backgroundSession)
      saveWorkbench.mockClear()

      for (const [seq, delta] of [
        [1, 'one'],
        [2, 'two'],
      ] as const) {
        store.handleAgentEvent({
          schemaVersion: 1,
          seq,
          ts: stamp,
          type: 'assistant.text.delta',
          sessionId: backgroundSession,
          runId,
          delta,
        })
      }

      expect(background.messages[0]?.text).toBe('onetwo')
      expect(saveWorkbench).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(250)
      expect(saveWorkbench).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
