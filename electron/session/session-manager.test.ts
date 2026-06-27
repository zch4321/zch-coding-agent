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
import type { AutoApprover } from '../permission/auto-approver'
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

class ScriptedCommandProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'command-request' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-command',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  mode: 'process',
                  executable: process.execPath,
                  args: ['--version'],
                }),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-command' as CallId,
            toolId: 'run_command',
            args: {
              mode: 'process',
              executable: process.execPath,
              args: ['--version'],
            },
            reason: 'Check Node version',
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
      delta: 'Checked Node version',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'command-complete' },
      turn: { role: 'assistant', content: 'Checked Node version' },
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
  calls = 0
  requests: Array<{
    messages: ProviderChatRequest['messages']
    tools: ProviderChatRequest['tools']
  }> = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
        tools: request.tools,
      },
      requestBytes: 10,
      prefixHash: `compact-${this.calls}`,
    })

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'old-run' },
        turn: { role: 'assistant', content: 'Old answer' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2) {
      yield {
        type: 'completed',
        rawResponse: { id: 'compact' },
        turn: { role: 'assistant', content: 'Compact summary retained' },
        toolCalls: [],
        usage: { total_tokens: 7 },
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'after-compact' },
      turn: { role: 'assistant', content: 'After compact' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class AutoCompactProvider implements LLMProvider {
  calls = 0
  requests: Array<{
    messages: ProviderChatRequest['messages']
    tools: ProviderChatRequest['tools']
  }> = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    })
    await request.onRequest?.({
      normalizedMessages: request.messages as unknown as JsonValue[],
      providerRequest: {
        model: 'fixture',
        messages: request.messages as unknown as JsonValue[],
        tools: request.tools,
      },
      requestBytes: 10,
      prefixHash: `auto-compact-${this.calls}`,
    })

    if (this.calls === 2) {
      yield {
        type: 'completed',
        rawResponse: { id: 'auto-compact' },
        turn: { role: 'assistant', content: 'Auto compact summary retained' },
        toolCalls: [],
        usage: { total_tokens: 9 },
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: `normal-${this.calls}` },
      turn: { role: 'assistant', content: `Normal response ${this.calls}` },
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

  constructor(private readonly activatePlan = false) {}

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

    if (this.calls === 2 && this.activatePlan) {
      const args = { status: 'active' }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-activate' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-status',
              type: 'function',
              function: {
                name: 'plan_status',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-status' as CallId,
            toolId: 'plan_status',
            args,
            reason: 'The user approved the plan',
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
          name: 'create_file',
          arguments: JSON.stringify({ path: fileName, content: fileName }),
        },
      }))
      yield {
        type: 'completed',
        rawResponse: {},
        turn: { role: 'assistant', content: null, tool_calls: toolCalls },
        toolCalls: toolCalls.map((toolCall) => ({
          id: toolCall.id as CallId,
          toolId: 'create_file',
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

function sseResponse(payloads: JsonValue[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
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
  it('uses configurable assistant preferences without replacing the base harness system message', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-prompt-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    await store.update({
      version: 1,
      kind: 'assistant',
      value: {
        language: 'en-US',
        preferences: {
          'zh-CN': '中文偏好',
          'en-US': 'English assistant preference selected by the test',
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
    expect(provider.messages[0]?.role).toBe('system')
    expect(provider.messages[1]?.role).toBe('user')
    expect(provider.messages[1]?.content).toContain('<environment_context')
    expect(
      provider.messages.some((message) => message.content === 'hello'),
    ).toBe(true)
    expect(
      provider.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content?.includes(
            'English assistant preference selected by the test',
          ),
      ),
    ).toBe(true)
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

  it('rewrites provider history for /compact and reinjects summary as user context', async () => {
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
      message: 'RAW_SHOULD_DROP first task',
      clientRequestId: 'request-before-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 1,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    manager.startRun({
      sessionId,
      message: '/compact focus on risks',
      clientRequestId: 'request-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 2,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      sent.find((envelope) => envelope.event.type === 'orchestrator.message')
        ?.event,
    ).toMatchObject({
      type: 'orchestrator.message',
      kind: 'compact',
      promptId: 'orchestration.compact.zh-CN',
    })
    expect(provider.requests[1]?.tools).toEqual([])
    expect(
      provider.requests[1]?.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('focus on risks'),
      ),
    ).toBe(true)

    manager.startRun({
      sessionId,
      message: 'continue after compact',
      clientRequestId: 'request-after-compact',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 3,
    )

    const afterCompactMessages = provider.requests[2]?.messages ?? []
    const rendered = JSON.stringify(afterCompactMessages)

    expect(rendered).not.toContain('RAW_SHOULD_DROP')
    expect(afterCompactMessages[0]?.role).toBe('system')
    expect(afterCompactMessages[1]?.role).toBe('user')
    expect(afterCompactMessages[1]?.content).toContain('<compact_history')
    expect(afterCompactMessages[1]?.content).toContain(
      'Compact summary retained',
    )
    expect(
      afterCompactMessages.some(
        (message) => message.content === 'continue after compact',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })

  it('auto compacts older history when the prompt reaches the configured threshold', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-auto-compact-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      baseURL: 'https://api.deepseek.com',
      model: 'auto-compact-test-model',
      reasoning: 'off',
      contextWindowTokens: 160_000,
      maxOutputTokens: 8_000,
      approverProviderId: 'deepseek',
      approverModel: 'deepseek-v4-flash',
      limits: {
        ...current.limits,
        autoCompactTriggerPercent: 50,
        tokenEstimation: { mode: 'custom-bytes', bytesPerToken: 1 },
      },
    })
    const provider = new AutoCompactProvider()
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
      message: `AUTO_OLD_CONTEXT ${'x'.repeat(90_000)}`,
      clientRequestId: 'request-auto-compact-old',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 1,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    manager.startRun({
      sessionId,
      message: 'AUTO_CURRENT_TURN must remain',
      clientRequestId: 'request-auto-compact-current',
    })

    await waitFor(
      () =>
        sent.filter(
          (envelope) =>
            envelope.event.type === 'run.status' &&
            envelope.event.status === 'completed',
        ).length >= 2,
    )

    expect(provider.requests[1]?.tools).toEqual([])
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'compact-auto',
      ),
    ).toBe(true)

    const afterAutoCompactMessages = provider.requests[2]?.messages ?? []
    const rendered = JSON.stringify(afterAutoCompactMessages)

    expect(rendered).not.toContain('AUTO_OLD_CONTEXT')
    expect(rendered).toContain('AUTO_CURRENT_TURN must remain')
    expect(afterAutoCompactMessages[0]?.role).toBe('system')
    expect(afterAutoCompactMessages[1]?.role).toBe('user')
    expect(afterAutoCompactMessages[1]?.content).toContain('<compact_history')
    expect(afterAutoCompactMessages[1]?.content).toContain(
      'Auto compact summary retained',
    )
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

  it('does not auto-continue a Plan awaiting review', async () => {
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

    expect(provider.calls).toBe(2)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'plan.updated' &&
          envelope.event.plan?.status === 'awaiting_review',
      ),
    ).toBe(true)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-continuation',
      ),
    ).toBe(false)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'orchestrator.message' &&
          envelope.event.kind === 'plan-warning',
      ),
    ).toBe(false)
    await manager.closeSession(sessionId)
  })

  it('auto-continues an active standalone Plan once and then warns', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new PlanWarningProvider(true)
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

    expect(provider.calls).toBe(4)
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

  it('completes an Auto edit through policy approval and records change evidence', async () => {
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
    expect(
      sent.find(
        (envelope) =>
          envelope.event.type === 'tool.completed' &&
          envelope.event.callId === 'call-edit',
      )?.event,
    ).not.toHaveProperty('approval')
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
      approvedBy: 'policy',
    })
    expect(toolCall?.policySignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'filesystem_patch' }),
      ]),
    )
    expect(toolCall?.diffHash).toEqual(expect.any(String))
  })

  it('uses JSON mode and thinking for default Auto approval requests', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-auto-approval-json-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)

    const store = await createConfig(directory)
    const current = store.getPublicConfig()
    await store.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'deepseek',
      label: 'DeepSeek',
      profile: 'deepseek',
      baseURL: 'https://api.example/v1',
      model: 'main-model',
      reasoning: 'off',
      approverProviderId: 'deepseek',
      approverModel: 'approval-model',
      limits: current.limits,
    })
    const provider = new ScriptedCommandProvider()
    const approvalBodies: JsonValue[] = []
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
      fetchImpl: async (_input, init) => {
        approvalBodies.push(JSON.parse(String(init?.body)) as JsonValue)
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'Check bounded command.',
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content:
                    '{"decision":"safe","note":"bounded process command"}',
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 6,
              total_tokens: 18,
            },
          },
        ])
      },
    })
    const sessionId = await manager.createSession({
      conversationId: 'conversation-auto-approval-json',
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    manager.startRun({
      sessionId,
      message: 'Check the local Node version',
      clientRequestId: 'request-auto-approval-json',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    expect(approvalBodies).toEqual([
      expect.objectContaining({
        model: 'approval-model',
        response_format: { type: 'json_object' },
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      }),
    ])
    await manager.closeSession(sessionId)
  })

  it('executes a command after Auto approval times out and the user approves', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-session-auto-approval-timeout-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)

    const store = await createConfig(directory)
    const provider = new ScriptedCommandProvider()
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
      autoApproverFactory: () => ({
        async evaluate() {
          return {
            decision: 'dangerous',
            note: 'Approval model timed out',
            valid: false,
            failure: 'timeout',
          }
        },
      }),
    })
    const sessionId = await manager.createSession({
      conversationId: 'conversation-auto-approval-timeout',
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Check the local Node version',
      clientRequestId: 'request-auto-approval-timeout',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'approval.requested' &&
          envelope.event.callId === 'call-command',
      ),
    )

    expect(
      manager.decideApproval({
        sessionId,
        runId,
        callId: 'call-command' as CallId,
        decision: 'allow',
      }),
    ).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    const completedTool = sent.find(
      (envelope) =>
        envelope.event.type === 'tool.completed' &&
        envelope.event.callId === 'call-command',
    )?.event

    expect(completedTool).toMatchObject({
      result: { status: 'ok' },
      approval: {
        approver: 'model',
        decision: 'dangerous',
        failure: 'timeout',
      },
    })
    await manager.closeSession(sessionId)
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

class InterjectionProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []
  // Resolves when the first tool-bearing turn has been consumed, allowing the
  // test to enqueue an interjection before the second provider call fires.
  firstTurnConsumed: { resolve: () => void; promise: Promise<void> }

  constructor() {
    let resolve: () => void = () => undefined
    this.firstTurnConsumed = {
      resolve: () => resolve(),
      promise: new Promise<void>((r) => {
        resolve = r
      }),
    }
  }

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'interject-first' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"notes.md"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-read' as CallId,
            toolId: 'read_file',
            args: { path: 'notes.md' },
            reason: 'Read the note',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      // Signal the test that the tool batch is about to run.
      this.firstTurnConsumed.resolve()
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Acknowledged the interjection',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'interject-final' },
      turn: {
        role: 'assistant',
        content: 'Acknowledged the interjection',
      },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

class FinalAnswerInterjectionProvider implements LLMProvider {
  calls = 0
  requests: ProviderChatRequest['messages'][] = []
  // Gate released by the test once the interjection has been queued, so the
  // first provider turn is held open until the run loop can observe it.
  firstTurnGate: { resolve: () => void; promise: Promise<void> }

  constructor() {
    let resolve: () => void = () => undefined
    this.firstTurnGate = {
      resolve: () => resolve(),
      promise: new Promise<void>((r) => {
        resolve = r
      }),
    }
  }

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))

    if (this.calls === 1) {
      yield {
        type: 'text.delta',
        delta: 'Initial final answer',
        raw: {},
      }
      // Hold the turn open until the test queues an interjection, then emit
      // the completion so the run loop observes the pending interjection
      // when it reaches the no-tool-calls branch.
      await this.firstTurnGate.promise
      yield {
        type: 'completed',
        rawResponse: { id: 'final-first' },
        turn: { role: 'assistant', content: 'Initial final answer' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Final answer after interjection',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'final-after' },
      turn: { role: 'assistant', content: 'Final answer after interjection' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

describe('SessionManager live interjections', () => {
  it('injects a queued interjection after a tool batch without canceling the run', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-interject-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'notes.md'), 'note body\n')
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-interject-base',
    })

    // Wait for the first provider turn (tool call) to be consumed.
    await provider.firstTurnConsumed.promise

    const accepted = manager.interjectRun({
      sessionId,
      runId,
      message: 'Remember to quote the note verbatim',
      clientRequestId: 'request-interject-1',
    })
    expect(accepted).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // The run was not canceled: a second provider call happened.
    expect(provider.calls).toBe(2)
    // An interjection.updated event with status queued was emitted.
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'queued',
      ),
    ).toBe(true)
    // An interjection.updated event with status injected was emitted.
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'injected',
      ),
    ).toBe(true)

    const secondRequest = provider.requests[1]
    const secondRequestText = JSON.stringify(secondRequest)
    expect(secondRequestText).toContain('<live_user_interjection>')
    expect(secondRequestText).toContain('Remember to quote the note verbatim')
    // The interjection is a user message that follows the tool result, not
    // interleaved between the assistant tool_call and its tool_result.
    const secondMessages = secondRequest
    const toolResultIndex = secondMessages.findIndex(
      (message) => message.role === 'tool',
    )
    const interjectionIndex = secondMessages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<live_user_interjection>'),
    )
    expect(toolResultIndex).toBeGreaterThanOrEqual(0)
    expect(interjectionIndex).toBeGreaterThan(toolResultIndex)

    await manager.closeSession(sessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('interjection.message')
    expect(trace).toContain('"status":"queued"')
    expect(trace).toContain('"status":"injected"')
  })

  it('treats a repeated clientRequestId as a no-op even after the interjection is injected', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-idem-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'notes.md'), 'note body\n')
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-idem-base',
    })

    await provider.firstTurnConsumed.promise

    manager.interjectRun({
      sessionId,
      runId,
      message: 'queued once',
      clientRequestId: 'request-idem-1',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'injected',
      ),
    )

    // Retry the same clientRequestId after injection: accepted but must not
    // re-queue, re-emit or re-inject.
    const accepted = manager.interjectRun({
      sessionId,
      runId,
      message: 'queued once',
      clientRequestId: 'request-idem-1',
    })
    expect(accepted).toBe(true)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // Exactly one queued and one injected event for this interjection id.
    const queuedCount = sent.filter(
      (envelope) =>
        envelope.event.type === 'interjection.updated' &&
        envelope.event.status === 'queued',
    ).length
    const injectedCount = sent.filter(
      (envelope) =>
        envelope.event.type === 'interjection.updated' &&
        envelope.event.status === 'injected',
    ).length
    expect(queuedCount).toBe(1)
    expect(injectedCount).toBe(1)

    // The second provider request contains the injected content exactly once
    // (the retry did not re-inject). Count the user content, not the tag,
    // because the tag also appears in the rule note.
    const secondRequestText = JSON.stringify(provider.requests[1])
    const contentCount = secondRequestText.split('queued once').length - 1
    expect(contentCount).toBe(1)
    await manager.closeSession(sessionId)
  })

  it('carries over a pending interjection as the next ordinary user turn when the model reached a final answer', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-final-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new FinalAnswerInterjectionProvider()
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
    const runId = manager.startRun({
      sessionId,
      message: 'Answer now',
      clientRequestId: 'request-final-base',
    })

    // Wait for the model's first answer text to stream, then queue the
    // interjection before releasing the provider gate so the run loop sees
    // the pending interjection at the no-tool-calls branch.
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.text.delta' &&
          envelope.event.delta === 'Initial final answer',
      ),
    )

    manager.interjectRun({
      sessionId,
      runId,
      message: 'Actually also mention the interjection',
      clientRequestId: 'request-final-interject',
    })
    provider.firstTurnGate.resolve()

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )

    // The run ended after the first final answer instead of forcing an extra
    // continuation that would overwrite it.
    expect(provider.calls).toBe(1)
    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'assistant.message.completed' &&
          envelope.event.text === 'Initial final answer',
      ),
    ).toBe(true)
    // The pending interjection was carried over as the next user turn.
    const carryover = sent.find(
      (envelope) => envelope.event.type === 'interjection.carryover',
    )?.event
    expect(carryover).toMatchObject({
      type: 'interjection.carryover',
      content: 'Actually also mention the interjection',
    })

    const nextRunId = manager.startRun({
      sessionId,
      message: 'Actually also mention the interjection',
      clientRequestId: 'request-final-carryover-next',
    })
    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.runId === nextRunId &&
          envelope.event.status === 'completed',
      ),
    )
    expect(provider.calls).toBe(2)
    expect(
      JSON.stringify(provider.requests[1]).includes(
        'Actually also mention the interjection',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId)
    const trace = await readFile(
      path.join(directory, 'traces', `${sessionId}.jsonl`),
      'utf8',
    )
    expect(trace).toContain('"status":"carryover"')
    expect(trace).toContain('Actually also mention the interjection')
  })

  it('supersedes pending interjections when the run is interrupted', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-interject-stop-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const store = await createConfig(directory)
    const provider = new InterjectionProvider()
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
      mode: 'yolo',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read notes.md',
      clientRequestId: 'request-stop-base',
    })

    await provider.firstTurnConsumed.promise

    manager.interjectRun({
      sessionId,
      runId,
      message: 'queued but will be superseded',
      clientRequestId: 'request-stop-interject',
    })
    manager.interruptRun(sessionId, runId)

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'cancelled',
      ),
    )

    expect(
      sent.some(
        (envelope) =>
          envelope.event.type === 'interjection.updated' &&
          envelope.event.status === 'superseded',
      ),
    ).toBe(true)
    await manager.closeSession(sessionId)
  })
})
