import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import { TODO_TOOL_ID } from '../../shared/todo'
import {
  ScriptedProviderHarness,
  type ScriptedProviderEvent as ProviderEvent,
  type TestProviderStreamRequest as ProviderStreamRequest,
} from '../providers/provider-test-harness'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'

/** Records provider context to verify Todo history continuity across Runs. */
class TodoHistoryProvider extends ScriptedProviderHarness {
  calls = 0
  readonly requests: ProviderStreamRequest['normalizedMessages'][] = []

  async *run(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))
    if (this.calls === 1) {
      const args = {
        explanation: 'Keep working from history',
        items: [{ step: 'Finish the task', status: 'in_progress' as const }],
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'todo-history-tool' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:todo-history',
              type: 'function',
              function: {
                name: TODO_TOOL_ID,
                arguments: JSON.stringify({
                  ...args,
                  _agent_intent: 'Track the current task',
                }),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:todo-history' as CallId,
            toolId: TODO_TOOL_ID,
            args,
            reason: 'Track the current task',
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
      rawResponse: { id: `todo-history-final-${this.calls}` },
      turn: {
        role: 'assistant',
        content:
          this.calls === 2 ? 'First Run complete' : 'Second Run complete',
      },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

describe('SessionManager Todo history', () => {
  it('carries the latest successful Todo through ordinary tool history', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-todo-history-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const provider = new TodoHistoryProvider()
    const events: AgentEventEnvelope[] = []
    const manager = new SessionManager({
      configStore: await createConfig(directory),
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => provider,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })

    manager.startRun({
      sessionId,
      message: 'Start a multi-step task.',
      clientRequestId: 'request:todo-history-first',
    })
    await waitFor(() => !manager.hasActiveRun(sessionId))

    manager.startRun({
      sessionId,
      message: 'Continue the same task.',
      clientRequestId: 'request:todo-history-second',
    })
    await waitFor(() => !manager.hasActiveRun(sessionId))

    expect(provider.requests).toHaveLength(3)
    const sameRunFollowUp = JSON.stringify(provider.requests[1])
    const nextRun = JSON.stringify(provider.requests[2])
    expect(sameRunFollowUp).toContain(TODO_TOOL_ID)
    expect(sameRunFollowUp).toContain('Finish the task')
    expect(nextRun).toContain(TODO_TOOL_ID)
    expect(nextRun).toContain('Finish the task')
    expect(nextRun).not.toContain('<todo_state>')
    expect(
      events.some(
        ({ event }) =>
          event.type === 'todo.updated' &&
          event.todo.items[0]?.step === 'Finish the task',
      ),
    ).toBe(true)

    await manager.closeSession(sessionId)
  })
})
