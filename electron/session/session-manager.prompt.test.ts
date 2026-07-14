import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { SessionId } from '../../shared/ids'
import {
  DEFAULT_HARNESS_PROMPT_REFS,
  PROMPT_RESOURCE_VERSION,
} from '../../shared/prompt-resources'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  PromptAuditProvider,
  ScriptedProvider,
} from './session-manager-prompt-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  ForkProvider,
  parseTrace,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager prompt and trace', () => {
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
      promptRegistry: await PromptRegistry.load(
        path.resolve('resources', 'prompts'),
      ),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
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
    }
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) =>
        webContents.send('', envelope),
      ),
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

  it('writes prompt build layers and prompt resources to real trace requests', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-prompt-trace-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(
      path.join(workspace, 'AGENTS.md'),
      'Trace AGENTS guidance\n',
    )
    const store = await createConfig(directory)
    const provider = new PromptAuditProvider()
    const sent: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: store,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((envelope) => sent.push(envelope)),
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
      message: 'Audit prompt metadata',
      clientRequestId: 'request-prompt-audit',
    })

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.event.type === 'run.status' &&
          envelope.event.status === 'completed',
      ),
    )
    await manager.closeSession(sessionId)

    const trace = parseTrace(
      await readFile(
        path.join(directory, 'traces', `${sessionId}.jsonl`),
        'utf8',
      ),
    )
    const llmRequest = trace.find((event) => event.type === 'llm.request')
    const layerKinds =
      llmRequest?.promptBuild?.layers?.map((layer) => layer.kind) ?? []
    const resources = llmRequest?.promptResources ?? []
    const resourceIds = resources.map((resource) => resource.id)

    expect(layerKinds).toEqual(
      expect.arrayContaining([
        'base_instructions',
        'runtime_context',
        'assistant_preferences',
        'agents',
      ]),
    )
    expect(resourceIds).toEqual(
      expect.arrayContaining([
        DEFAULT_HARNESS_PROMPT_REFS.baseInstructions['zh-CN'].id,
        DEFAULT_HARNESS_PROMPT_REFS.runtimeContext['zh-CN'].id,
      ]),
    )
    expect(
      resources.every(
        (resource) =>
          resource.version === PROMPT_RESOURCE_VERSION &&
          typeof resource.path === 'string' &&
          resource.path.length > 0 &&
          /^[a-f0-9]{64}$/u.test(resource.sha256 ?? ''),
      ),
    ).toBe(true)
    expect(String(llmRequest?.normalizedMessages?.[1]?.content ?? '')).toMatch(
      /^<environment_context/u,
    )
    expect(provider.requests[0]?.[1]?.role).toBe('user')
  })
})
