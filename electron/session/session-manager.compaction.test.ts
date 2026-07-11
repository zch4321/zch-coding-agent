import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import { PromptRegistry } from '../prompts/registry'
import { SessionManager } from './session-manager'
import {
  AutoCompactProvider,
  CompactProvider,
} from './session-manager-compaction-fixtures'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

describe('SessionManager compaction', () => {
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
    expect(afterCompactMessages[1]?.content).toContain(
      'Orchestration state at compaction:',
    )
    expect(afterCompactMessages[1]?.content).toContain('Goal: none')
    expect(afterCompactMessages[1]?.content).toContain('Plan: none')
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
})
