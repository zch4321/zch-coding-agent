import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from './provider'
import type { AutoApprover } from './auto-approver'
import { SessionManager } from './session-manager'

class FakeSafeStorage implements SafeStorageAdapter {
  readonly platform = 'win32'

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'system'
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(`encrypted:${value}`)
  }

  async decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return {
      result: value.toString().replace(/^encrypted:/, ''),
      shouldReEncrypt: false,
    }
  }
}

class ScriptedProvider implements LLMProvider {
  calls = 0

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
      },
      requestBytes: 10,
      prefixHash: `fixture-${this.calls}`,
    })

    if (this.calls === 1) {
      yield {
        type: 'reasoning.delta',
        delta: 'Need README.',
        raw: { type: 'reasoning.delta' },
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'first' },
        turn: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Need README.',
          tool_calls: [
            {
              id: 'call-readme',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-readme' as CallId,
            toolId: 'read_file',
            args: { path: 'README.md' },
            reason: '',
          },
        ],
        usage: { total_tokens: 8 },
        providerState: { turn: 1 },
        timing: { ttftMs: 1, totalMs: 2 },
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'README summary',
      raw: { type: 'text.delta' },
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'second' },
      turn: { role: 'assistant', content: 'README summary' },
      toolCalls: [],
      usage: { total_tokens: 12 },
      providerState: { turn: 2 },
      timing: { ttftMs: 1, totalMs: 2 },
    }
  }
}

class ScriptedEditProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1

    if (this.calls === 1) {
      const args = {
        path: 'note.txt',
        patch: [
          '--- a/note.txt',
          '+++ b/note.txt',
          '@@ -1,2 +1,2 @@',
          ' alpha',
          '-beta',
          '+gamma',
        ].join('\n'),
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'edit-request' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-edit',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-edit' as CallId,
            toolId: 'apply_patch',
            args,
            reason: 'Update the requested line',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Updated note.txt',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'edit-complete' },
      turn: { role: 'assistant', content: 'Updated note.txt' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

const safeAutoApprover: AutoApprover = {
  async evaluate() {
    return {
      decision: 'safe',
      note: 'Single bounded workspace edit',
      valid: true,
    }
  },
}

async function createConfig(directory: string, secret = 'secret-sentinel') {
  const store = new ConfigStore(
    path.join(directory, 'config.json'),
    new SecretStore(
      path.join(directory, 'secrets.json'),
      new FakeSafeStorage(),
    ),
  )
  await store.initialize()
  await store.update({
    version: 1,
    kind: 'privacy',
    providerNoticeAccepted: {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: '2026-06-17T00:00:00.000Z',
    },
    traceNoticeAccepted: {
      version: TRACE_NOTICE_VERSION,
      acceptedAt: '2026-06-17T00:00:00.000Z',
    },
  })
  await store.update({
    version: 1,
    kind: 'credential',
    action: 'set',
    apiKey: secret,
  })
  await store.update({
    version: 1,
    kind: 'logging',
    value: {
      ...store.getPublicConfig().logging,
      enabled: true,
    },
  })
  return store
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}

describe('SessionManager P2 loop', () => {
  it('runs a deterministic read-only README summary and keeps credentials out of trace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), '# Project\nhello\n')

    const store = await createConfig(directory)
    const provider = new ScriptedProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    } as WebContents
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () => webContents,
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Read README and summarize it',
      clientRequestId: 'request-1',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'tool.completed' &&
          envelope.event.result.status === 'ok',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.text.delta' &&
          envelope.event.delta === 'README summary',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId as SessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('tool.call')
    expect(trace).not.toContain('secret-sentinel')
  })

  it('completes an Auto edit and records P3 approval evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-p3-'))
    const workspace = path.join(directory, 'workspace')
    const target = path.join(workspace, 'note.txt')
    await mkdir(workspace)
    await writeFile(target, 'alpha\nbeta\n')

    const store = await createConfig(directory)
    const provider = new ScriptedEditProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    } as WebContents
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () => webContents,
      providerFactory: () => provider,
      autoApproverFactory: () => safeAutoApprover,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Change beta to gamma in note.txt',
      clientRequestId: 'request-p3-edit',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(await readFile(target, 'utf8')).toBe('alpha\ngamma\n')
    await manager.closeSession(sessionId)
    const trace = (
      await readFile(
        path.join(directory, 'traces', `${sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const toolCall = trace.find((event) => event.type === 'tool.call')

    expect(toolCall).toMatchObject({
      tool: 'apply_patch',
      approvedBy: 'model',
    })
    expect(toolCall?.policySignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'filesystem_patch' }),
      ]),
    )
    expect(toolCall?.diffHash).toEqual(expect.any(String))
  })

  it('accepts one Confirm decision and persists a bounded remembered rule', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-confirm-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'note.txt'), 'alpha\nbeta\n')

    const store = await createConfig(directory)
    const provider = new ScriptedEditProvider()
    const sent: AgentEventEnvelope[] = []
    const webContents = {
      isDestroyed: () => false,
      send: (_channel: string, envelope: AgentEventEnvelope) => {
        sent.push(envelope)
      },
    } as WebContents
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () => webContents,
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const otherSessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Change beta to gamma in note.txt',
      clientRequestId: 'request-confirm-edit',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.kind === 'tool',
      ),
    )
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()

    expect(
      manager.decideApproval({
        sessionId: otherSessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
      }),
    ).toBe(false)
    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
        remember: { workspaceScope: 'workspace', expiresAt },
      }),
    ).toBe(true)
    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-edit' as CallId,
        decision: 'allow',
      }),
    ).toBe(false)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === runId &&
          envelope.event.status === 'completed',
      ),
    )

    expect(store.getPublicConfig().permission.rememberedRules).toEqual([
      expect.objectContaining({
        effect: 'allow',
        toolId: 'apply_patch',
        workspaceScope: workspace,
        argConstraints: { path: 'note.txt' },
        expiresAt,
        createdFromCallId: 'call-edit',
      }),
    ])
    await manager.closeSession(sessionId)
    await manager.closeSession(otherSessionId)
  })
})
