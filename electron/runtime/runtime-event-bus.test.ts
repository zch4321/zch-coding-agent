import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type { RunId, SessionId } from '../../shared/ids'
import { RuntimeEventBus } from './runtime-event-bus'

const sessionId = 'session:runtime-events' as SessionId
const runId = 'run:runtime-events' as RunId

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
})
