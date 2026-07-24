import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEventEnvelope } from '../../shared/ipc-contract'
import type { CallId } from '../../shared/ids'
import type { LLMProvider, ProviderEvent } from '../providers/provider'
import type { SessionExecutionStatePort, SessionState } from './session-types'
import {
  createConfig,
  createIpcTestEventSink,
  waitFor,
} from './session-manager-test-support'
import { SessionManager } from './session-manager'

class InvalidThenValidProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      const args = { path: 'README.md' }
      yield {
        type: 'completed',
        rawResponse: { id: 'invalid-duplicate-call' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call:duplicate',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
            {
              id: 'call:duplicate',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call:duplicate' as CallId,
            toolId: 'read_file',
            args,
            reason: '',
          },
          {
            id: 'call:duplicate' as CallId,
            toolId: 'read_file',
            args,
            reason: '',
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
      rawResponse: { id: 'valid-follow-up' },
      turn: { role: 'assistant', content: 'Recovered safely' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

describe('SessionManager Provider completion validation', () => {
  it('rejects before tools or canonical append and accepts the next run', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-provider-validation-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const provider = new InvalidThenValidProvider()
    const events: AgentEventEnvelope[] = []
    const committedHistories: SessionState['history'][] = []
    const executionState: SessionExecutionStatePort = {
      commit: async (session) => {
        committedHistories.push(structuredClone(session.history))
        return undefined
      },
    }
    const manager = new SessionManager({
      configStore,
      traceDirectory: path.join(directory, 'traces'),
      eventSink: createIpcTestEventSink((event) => events.push(event)),
      providerFactory: () => provider,
      executionState,
    })
    const sessionId = await manager.createSession({
      conversationId: 'provider-validation',
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })

    const rejectedRunId = manager.startRun({
      sessionId,
      message: 'Read the file',
      clientRequestId: 'request:invalid-provider',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === rejectedRunId &&
          event.status === 'failed',
      ),
    )

    expect(
      events.filter(
        ({ event }) =>
          (event.type === 'tool.proposed' ||
            event.type === 'approval.requested') &&
          event.runId === rejectedRunId,
      ),
    ).toEqual([])
    expect(
      committedHistories
        .flat()
        .filter((record) => record.kind === 'assistant_turn'),
    ).toEqual([])

    const validRunId = manager.startRun({
      sessionId,
      message: 'Answer without tools',
      clientRequestId: 'request:valid-provider',
    })
    await waitFor(() =>
      events.some(
        ({ event }) =>
          event.type === 'run.status' &&
          event.runId === validRunId &&
          event.status === 'completed',
      ),
    )

    expect(
      committedHistories
        .at(-1)
        ?.filter((record) => record.kind === 'assistant_turn'),
    ).toHaveLength(1)
    expect(provider.calls).toBe(2)
    await manager.closeSession(sessionId)
  })
})
