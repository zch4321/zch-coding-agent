import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type { AgentExecutionEvent } from '../../shared/agent-execution'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { RuntimeEventBus } from './runtime-event-bus'

const sessionId = 'session:runtime-events' as SessionId
const runId = 'run:runtime-events' as RunId
const parentCallId = 'call:runtime-events' as CallId

function runStatus(status: 'calling_llm' | 'completed'): AgentEvent {
  return {
    schemaVersion: 1,
    seq: status === 'completed' ? 2 : 1,
    ts: new Date().toISOString(),
    type: 'run.status',
    sessionId,
    runId,
    status,
  }
}

describe('RuntimeEventBus', () => {
  it('retains terminal run completion without external subscribers', async () => {
    const bus = new RuntimeEventBus()
    bus.publishAgent(runStatus('completed'))

    await expect(bus.waitForRun(sessionId, runId)).resolves.toMatchObject({
      sessionId,
      runId,
      status: 'completed',
    })
  })

  it('isolates listener failures and resolves active waiters', async () => {
    const diagnostic = vi.fn()
    const received: AgentEvent[] = []
    const bus = new RuntimeEventBus({ onDiagnostic: diagnostic })
    bus.subscribe({
      onAgentEvent: () =>
        void (() => {
          throw new Error('boom')
        })(),
    })
    bus.subscribe({ onAgentEvent: (event) => received.push(event) })
    const completion = bus.waitForRun(sessionId, runId)

    bus.publishAgent(runStatus('calling_llm'))
    bus.publishAgent(runStatus('completed'))

    await expect(completion).resolves.toMatchObject({ status: 'completed' })
    expect(received).toHaveLength(2)
    expect(diagnostic).toHaveBeenCalledTimes(2)
  })

  it('rejects waiters when disposed', async () => {
    const bus = new RuntimeEventBus()
    const completion = bus.waitForRun(sessionId, runId)
    bus.dispose()
    await expect(completion).rejects.toThrow('disposed')
  })

  it('sequences concurrent execution streams independently', () => {
    const received: AgentExecutionEvent[] = []
    const bus = new RuntimeEventBus()
    bus.subscribe({
      onAgentExecutionEvent: (event) => received.push(event),
    })
    const first = 'subagent:runtime-first' as AgentExecutionId
    const second = 'subagent:runtime-second' as AgentExecutionId
    const identity = (executionId: AgentExecutionId) => ({
      executionId,
      parentSessionId: sessionId,
      parentRunId: runId,
      parentCallId,
    })

    bus.publishAgentExecution({
      ...identity(first),
      type: 'run.status',
      status: 'calling_llm',
    })
    bus.publishAgentExecution({
      ...identity(second),
      type: 'run.status',
      status: 'calling_llm',
    })
    bus.publishAgentExecution({
      ...identity(second),
      type: 'assistant.text.delta',
      delta: 'second',
    })
    bus.publishAgentExecution({
      ...identity(first),
      type: 'assistant.reasoning.delta',
      delta: 'first',
    })

    expect(
      received.map((event) => [event.executionId, event.seq, event.type]),
    ).toEqual([
      [first, 1, 'run.status'],
      [second, 1, 'run.status'],
      [second, 2, 'assistant.text.delta'],
      [first, 2, 'assistant.reasoning.delta'],
    ])
  })
})
