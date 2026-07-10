// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  toPublicConfig,
} from '../../electron/config/schema'
import type { RunId } from '../../shared/ids'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
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

describe('agent store requests and approvals', () => {
  setupAgentTest()

  it('sends typed @path and selected chips as structured context attachments', async () => {
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
    store.input = 'Review @README.md and @src/'
    store.contextAttachments = [
      { kind: 'directory', path: 'docs', source: 'picker' },
    ]

    await store.sendMessage()

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          attachments: [
            { kind: 'directory', path: 'docs', source: 'picker' },
            { kind: 'file', path: 'README.md', source: 'mention' },
            { kind: 'directory', path: 'src', source: 'mention' },
          ],
        },
      }),
    )
    expect(store.contextAttachments).toEqual([])
    expect(store.messages[0]?.attachments).toMatchObject([
      { kind: 'directory', path: 'docs' },
      { kind: 'file', path: 'README.md' },
      { kind: 'directory', path: 'src' },
    ])
  })

  it('keeps a carried-over interjection until the next user turn starts successfully', async () => {
    const config = toPublicConfig(DEFAULT_APP_CONFIG, true)
    config.privacy.providerNoticeAccepted = {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-22T00:00:00.000Z',
    }
    const startRun = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1 as const,
        ok: false as const,
        error: {
          code: 'CONFLICT',
          message: 'This session already has an active run',
        },
      })
      .mockResolvedValueOnce({
        version: 1 as const,
        ok: true as const,
        value: { runId: 'run:carryover' as RunId },
      })
    installApi({ startRun })
    const store = useAgentStore()
    const runtime = useAgentRuntimeStore()
    store.bridgeAvailable = true
    store.applyConfig(config)
    store.workspacePath = 'F:/workspace/example'
    store.createConversation()
    registerActiveSession(store)
    store.registerRun(store.activeConversationId!, runId)
    store.input = 'draft already typed'
    store.contextAttachments = [
      { kind: 'file', path: 'draft.md', source: 'picker' },
    ]
    store.messages.push({
      id: 'message:interjection-carryover',
      role: 'interjection',
      runId,
      text: 'Use the alternate approach',
      reasoning: '',
      interjectionId: 'interjection:carryover',
      interjectionStatus: 'queued',
      order: 1,
    })

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'interjection.carryover',
      sessionId,
      runId,
      interjectionId: 'interjection:carryover',
      content: 'Use the alternate approach',
      createdAt: stamp,
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: stamp,
      type: 'run.status',
      sessionId,
      runId,
      status: 'completed',
    })
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    expect(store.input).toBe('draft already typed')
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'interjection',
          interjectionId: 'interjection:carryover',
          interjectionStatus: 'carryover',
          text: 'Use the alternate approach',
        }),
      ]),
    )

    await runtime.flushCarryoverInterjections()

    expect(startRun).toHaveBeenCalledTimes(2)
    expect(startRun).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ context: expect.anything() }),
    )
    expect(store.input).toBe('draft already typed')
    expect(store.contextAttachments).toEqual([
      { kind: 'file', path: 'draft.md', source: 'picker' },
    ])
    expect(
      store.messages.some(
        (message) => message.interjectionId === 'interjection:carryover',
      ),
    ).toBe(false)
    expect(store.messages.at(-1)).toMatchObject({
      role: 'user',
      text: 'Use the alternate approach',
    })
  })
})
