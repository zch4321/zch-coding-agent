// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { SessionRecord } from '../../shared/session'
import { installApi, setupAgentTest } from './agent-test-support'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'

const sessionId = 'session:markdown-export' as SessionId

function session(): SessionRecord {
  return {
    schemaVersion: 1,
    id: sessionId,
    projectId: 'project:markdown-export' as ProjectId,
    title: 'Markdown export',
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
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  }
}

describe('agent runtime Markdown export', () => {
  setupAgentTest()

  it('requires a known Session and sends explicit confirmation', async () => {
    const exportConversationMarkdown = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { canceled: false, path: 'F:/exports/conversation.md' },
    }))
    installApi({ exportConversationMarkdown })
    const runtime = useAgentRuntimeStore()

    await expect(runtime.exportConversationMarkdown(sessionId)).resolves.toBe(
      false,
    )
    expect(exportConversationMarkdown).not.toHaveBeenCalled()

    useAgentReplicaStore().sessions = [session()]
    await expect(runtime.exportConversationMarkdown(sessionId)).resolves.toBe(
      true,
    )
    expect(exportConversationMarkdown).toHaveBeenCalledWith({
      version: 1,
      sessionId,
      confirmed: true,
    })
  })
})
