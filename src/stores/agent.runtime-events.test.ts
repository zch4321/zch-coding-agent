// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { useAgentStore } from './agent'
import {
  callId,
  registerActiveSession,
  runId,
  sessionId,
  setupAgentTest,
  stamp,
} from './agent-test-support'

describe('agent store runtime events', () => {
  setupAgentTest()

  it('starts a new assistant segment after a tool call', () => {
    const store = useAgentStore()
    registerActiveSession(store)
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'First response',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'tool.proposed',
      sessionId,
      runId,
      callId,
      tool: 'run_command',
      args: { mode: 'shell', command: 'npm --version' },
      reason: 'Check npm version',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 3,
      ts: '2026-06-20T00:00:02.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'Second response',
    })

    expect(store.messages.map((message) => message.text)).toEqual([
      'First response',
      'Second response',
    ])
    expect([
      store.messages[0]?.order,
      store.tools[0]?.order,
      store.messages[1]?.order,
    ]).toEqual([1, 2, 3])
  })

  it('attaches auto approval summaries to completed tools', () => {
    const store = useAgentStore()
    registerActiveSession(store)
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'tool.proposed',
      sessionId,
      runId,
      callId,
      tool: 'create_file',
      args: { path: 'note.txt', content: 'updated' },
      reason: 'Write the requested file',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'tool.completed',
      sessionId,
      runId,
      callId,
      result: { status: 'ok', content: { path: 'note.txt' } },
      approval: {
        approver: 'model',
        decision: 'safe',
        reason: 'Single bounded workspace edit',
        valid: true,
      },
    })

    expect(store.tools[0]).toMatchObject({
      status: 'completed',
      approval: {
        approver: 'model',
        decision: 'safe',
        reason: 'Single bounded workspace edit',
      },
    })
  })

  it('renders completed assistant messages even if stream deltas were missed', () => {
    const store = useAgentStore()
    registerActiveSession(store)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.message.completed',
      sessionId,
      runId,
      text: 'Final answer',
      reasoning: 'Final reasoning',
    })

    expect(store.messages[0]).toMatchObject({
      role: 'assistant',
      runId,
      text: 'Final answer',
      reasoning: 'Final reasoning',
    })
  })

  it('uses completed assistant messages as an idempotent final snapshot', () => {
    const store = useAgentStore()
    registerActiveSession(store)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: '2026-06-20T00:00:00.000Z',
      type: 'assistant.text.delta',
      sessionId,
      runId,
      delta: 'Part',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: '2026-06-20T00:00:01.000Z',
      type: 'assistant.message.completed',
      sessionId,
      runId,
      text: 'Part plus final text',
    })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]?.text).toBe('Part plus final text')
  })

  it('routes orchestration and usage events through the runtime dispatcher', () => {
    const store = useAgentStore()
    registerActiveSession(store)

    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 1,
      ts: stamp,
      type: 'assistant.reasoning.delta',
      sessionId,
      runId,
      delta: 'Thinking step',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 2,
      ts: stamp,
      type: 'llm.usage',
      sessionId,
      runId,
      callId,
      usage: {
        scope: 'main',
        providerId: 'deepseek',
        providerLabel: 'DeepSeek',
        model: 'deepseek-v4-flash',
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
        contextWindowTokens: 128_000,
        contextWindowSource: 'builtin',
        raw: {},
      },
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 3,
      ts: stamp,
      type: 'orchestrator.message',
      sessionId,
      runId,
      kind: 'plan-warning',
      text: 'Review the current plan before continuing.',
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 4,
      ts: stamp,
      type: 'goal.updated',
      sessionId,
      runId,
      goal: {
        id: 'goal:test',
        objective: 'Complete the refactor',
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
        continuationCount: 1,
      },
    })
    store.handleAgentEvent({
      schemaVersion: 1,
      seq: 5,
      ts: stamp,
      type: 'plan.updated',
      sessionId,
      runId,
      plan: {
        id: 'plan:test',
        objective: 'Split runtime handlers',
        status: 'active',
        items: [
          {
            id: 'item:test',
            title: 'Move event handling',
            status: 'completed',
            updatedAt: stamp,
          },
        ],
        createdAt: stamp,
        updatedAt: stamp,
        continuationCount: 0,
      },
    })

    expect(store.messages[0]).toMatchObject({
      role: 'assistant',
      reasoning: 'Thinking step',
      order: 1,
    })
    expect(store.usage[0]).toMatchObject({
      runId,
      callId,
      usage: expect.objectContaining({ totalTokens: 125 }),
      order: 2,
    })
    expect(store.messages[1]).toMatchObject({
      role: 'orchestrator',
      text: 'Review the current plan before continuing.',
      order: 3,
    })
    expect(store.goal).toMatchObject({ id: 'goal:test', status: 'active' })
    expect(store.plan).toMatchObject({ id: 'plan:test', status: 'active' })
  })
})
