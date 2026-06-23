import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId, EventId, SessionId } from '../../shared/ids'
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
} from '../providers/provider'
import type { AutoApprover } from './auto-approver'
import { SessionManager } from './session-manager'
import { ChangeHistoryStore } from './change-history'
import { PromptRegistry } from '../prompts/registry'

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

class ForkProvider implements LLMProvider {
  calls = 0
  messages: ProviderChatRequest['messages'] = []
  providerRequestOverride: JsonValue | undefined

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.messages = structuredClone(request.messages)
    this.providerRequestOverride = structuredClone(
      request.providerRequestOverride,
    )
    yield {
      type: 'completed',
      rawResponse: { id: 'fork-complete' },
      turn: { role: 'assistant', content: 'Fork complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class CompactProvider implements LLMProvider {
  messages: ProviderChatRequest['messages'] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.messages = structuredClone(request.messages)
    yield {
      type: 'completed',
      rawResponse: { id: 'compact' },
      turn: { role: 'assistant', content: 'Compact summary' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class GoalContinuationProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'goal-first' },
        turn: { role: 'assistant', content: 'Working on the goal' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2) {
      const args = {
        summary: 'Goal finished',
        evidence: 'Continuation requested explicit completion',
        remainingRisks: 'none',
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'goal-complete' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-goal-complete',
              type: 'function',
              function: {
                name: 'goal_complete',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-goal-complete' as CallId,
            toolId: 'goal_complete',
            args,
            reason: 'The goal is complete',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'goal-final' },
      turn: { role: 'assistant', content: 'Goal complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class PlanWarningProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1

    if (this.calls === 1) {
      const args = { items: ['Inspect state', 'Report result'] }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-set' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-set',
              type: 'function',
              function: {
                name: 'plan_set',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-set' as CallId,
            toolId: 'plan_set',
            args,
            reason: 'Create the requested plan',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: `plan-open-${this.calls}` },
      turn: { role: 'assistant', content: 'Plan still open' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class MultiToolCancellationProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (this.calls === 1) {
      const toolCalls = ['first.txt', 'second.txt'].map((fileName, index) => ({
        id: `call-write-${index + 1}`,
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: fileName, content: fileName }),
        },
      }))
      yield {
        type: 'completed',
        rawResponse: {},
        turn: { role: 'assistant', content: null, tool_calls: toolCalls },
        toolCalls: toolCalls.map((toolCall) => ({
          id: toolCall.id as CallId,
          toolId: 'write_file',
          args: JSON.parse(toolCall.function.arguments) as JsonValue,
          reason: 'Create cancellation fixture',
        })),
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: {},
      turn: { role: 'assistant', content: 'Recovered after cancellation' },
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
  it('uses the configurable system prompt selected by application language', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-prompt-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'assistant',
      value: {
        language: 'en-US',
        systemPrompts: {
          'zh-CN': '中文系统提示',
          'en-US': 'English system prompt selected by the test',
        },
      },
    })
    const provider = new ForkProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'hello',
      clientRequestId: 'prompt-request',
    })

    await waitFor(() =>
      sent.some(
        ({ event }) =>
          event.type === 'run.status' && event.status === 'completed',
      ),
    )
    expect(provider.messages[0]).toEqual({
      role: 'system',
      content: 'English system prompt selected by the test',
    })
    await manager.closeSession(sessionId)
  })

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
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.message.completed' &&
          envelope.event.text === 'README summary',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId as SessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('tool.call')
    expect(trace).not.toContain('llm.stream')
    expect(trace).toContain('llm.response')
    expect(trace).not.toContain('secret-sentinel')
  })

  it('renders /compact as a visible orchestrator prompt without deleting history', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-compact-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new CompactProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/compact focus on risks',
      clientRequestId: 'request-compact',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(
      sent.find((envelope) => envelope.event.type === 'orchestrator.message')
        ?.event,
    ).toMatchObject({
      type: 'orchestrator.message',
      kind: 'compact',
      promptId: 'orchestration.compact.zh-CN',
    })
    expect(
      provider.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('focus on risks'),
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('continues an active Goal until the model explicitly completes it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-goal-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new GoalContinuationProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/goal Produce a verified result',
      clientRequestId: 'request-goal',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(3)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'goal-continuation',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'goal.updated' &&
          envelope.event.goal?.status === 'completed',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('auto-continues a standalone Plan once and then warns', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new PlanWarningProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, envelope: AgentEventEnvelope) =>
            sent.push(envelope),
        }) as unknown as WebContents,
      providerFactory: () => provider,
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: '/plan Check something',
      clientRequestId: 'request-plan',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(provider.calls).toBe(3)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-continuation',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-warning',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('completes an Auto edit and records P3 approval evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-p3-'))
    const workspace = path.join(directory, 'workspace')
    const target = path.join(workspace, 'note.txt')
    await mkdir(workspace)
    await writeFile(target, 'alpha\nbeta\n')

    const store = await createConfig(directory)
    const changeHistory = new ChangeHistoryStore(
      path.join(directory, 'change-history.json'),
    )
    await changeHistory.initialize()
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
      changeHistory,
    })
    const sessionId = await manager.createSession({
      conversationId: 'conversation-p3',
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
    expect(changeHistory.list('conversation-p3', workspace)).toMatchObject([
      {
        path: 'note.txt',
        operation: 'patch',
      },
    ])
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
        workspaceScope: path.resolve(await realpath(workspace)),
        argConstraints: { path: 'note.txt' },
        expiresAt,
        createdFromCallId: 'call-edit',
      }),
    ])
    await manager.closeSession(sessionId)
    await manager.closeSession(otherSessionId)
  })

  it('fills every tool result when a multi-tool turn is interrupted', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-cancel-tools-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new MultiToolCancellationProvider()
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
    const firstRunId = manager.startRun({
      sessionId,
      message: 'Create both files',
      clientRequestId: 'request-cancel-tools',
    })

    await waitFor(() =>
      sent.some((envelope) => envelope.event.type === 'approval.requested'),
    )
    expect(manager.interruptRun(sessionId, firstRunId)).toBe(true)
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === firstRunId &&
          envelope.event.status === 'cancelled',
      ),
    )

    manager.startRun({
      sessionId,
      message: 'Continue safely',
      clientRequestId: 'request-after-cancel',
    })
    await waitFor(() => provider.calls === 2)

    expect(
      provider.requests[1]?.filter((message) => message.role === 'tool'),
    ).toHaveLength(2)
    expect(
      await readFile(path.join(workspace, 'first.txt'), 'utf8').catch(
        () => 'missing',
      ),
    ).toBe('missing')
    await manager.closeSession(sessionId)
  })

  it('forks recorded context without replaying historical side effects', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-fork-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const notePath = path.join(workspace, 'note.txt')
    await writeFile(notePath, 'unchanged\n')
    const store = await createConfig(directory)
    const provider = new ForkProvider()
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      getWebContents: () => undefined,
      providerFactory: () => provider,
    })
    const sourceEventId = 'event-source-request' as EventId
    const fork = await manager.createForkFromTrace({
      workspace,
      mode: 'confirm',
      sourceEventId,
      providerRequest: { model: 'recorded-model', temperature: 0.25 },
      messages: [
        { role: 'system', content: 'Recorded system prompt' },
        { role: 'user', content: 'Previously requested edit' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'historical-call',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'historical-call',
          content: '{"status":"ok"}',
        },
      ],
    })
    manager.startForkRun(fork.sessionId)

    await waitFor(() => provider.calls === 1)
    await manager.closeSession(fork.sessionId)
    expect(await readFile(notePath, 'utf8')).toBe('unchanged\n')
    expect(provider.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'historical-call',
        }),
      ]),
    )
    expect(provider.providerRequestOverride).toEqual({
      model: 'recorded-model',
      temperature: 0.25,
    })

    const trace = (
      await readFile(
        path.join(directory, 'traces', `${fork.sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(trace[0]).toMatchObject({
      type: 'session.start',
      forkedFromEventId: sourceEventId,
    })
  })
})
