import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import { BackgroundWakeupGate } from '../session/background-wakeup-gate'
import { BackgroundNotificationService } from './background-notification-service'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'

const parent = 'session:parent' as SessionId
const record = {
  id: 'agent:child' as AgentExecutionId,
  parentSessionId: parent,
  status: 'completed',
} as SubagentExecutionRecord
const message = {
  kind: 'background_task_notification',
  source: 'background.lifecycle',
  text: 'safe result',
}
function fixture(enabled = true) {
  const gate = new BackgroundWakeupGate()
  let idle = true
  const start = vi.fn((id: SessionId, claim: object) => gate.valid(id, claim))
  const service = new BackgroundNotificationService({
    enabled,
    eligible: () => idle,
    claim: (id) => gate.claim(id),
    message: async () => message,
    start,
    diagnostic: vi.fn(),
  })
  const natural = () => {
    const epoch = gate.invalidate(parent)
    gate.settled(parent, epoch, true)
  }
  return {
    gate,
    start,
    service,
    natural,
    setIdle: (value: boolean) => {
      idle = value
    },
  }
}

describe('instant-only parent wakeups', () => {
  it('claims only natural completion and invalidates claims on newer intent', () => {
    const gate = new BackgroundWakeupGate()
    const run = gate.invalidate(parent)
    gate.settled(parent, run, false)
    expect(gate.claim(parent)).toBeUndefined()
    gate.settled(parent, run, true)
    expect(gate.claim(parent)).toBe(run)
    expect(gate.claim(parent)).toBeUndefined()
    gate.invalidate(parent)
    expect(gate.valid(parent, run)).toBe(false)
    gate.settled(parent, run, true)
    expect(gate.claim(parent)).toBeUndefined()
    gate.forget(parent)
    expect(gate.claim(parent)).toBeUndefined()
  })

  it('drops events while busy and never replays them when the parent later becomes idle', async () => {
    const test = fixture()
    test.natural()
    test.setIdle(false)
    test.service.child(record, 'settled')
    test.setIdle(true)
    await Promise.resolve()
    expect(test.start).not.toHaveBeenCalled()
    test.service.child(record, 'settled')
    test.service.child(record, 'settled')
    await Promise.resolve()
    expect(test.start).toHaveBeenCalledOnce()
    await test.service.dispose()
  })

  it('does not start after a user Run wins during projection preparation', async () => {
    const gate = new BackgroundWakeupGate()
    let deliver!: (value: typeof message) => void
    const pending = new Promise<typeof message>((resolve) => {
      deliver = resolve
    })
    const start = vi.fn((id: SessionId, claim: object) => gate.valid(id, claim))
    const service = new BackgroundNotificationService({
      enabled: true,
      eligible: () => true,
      claim: (id) => gate.claim(id),
      message: () => pending,
      start,
      diagnostic: vi.fn(),
    })
    const epoch = gate.invalidate(parent)
    gate.settled(parent, epoch, true)
    service.child(record, 'settled')
    gate.invalidate(parent)
    deliver(message)
    await Promise.resolve()
    expect(start).toHaveReturnedWith(false)
    await service.dispose()
  })

  it('notifies group completion/attention, ignores ordinary initial child completion and explicit cancellation', async () => {
    const test = fixture()
    const child = {
      ...record,
      parentExecutionId: 'agent:swarm' as AgentExecutionId,
    }
    test.natural()
    test.service.child(child, 'settled')
    test.service.child({ ...record, status: 'cancelled' }, 'settled')
    await Promise.resolve()
    expect(test.start).not.toHaveBeenCalled()
    test.service.child(child, 'paused', 'timeout')
    await Promise.resolve()
    expect(test.start).toHaveBeenCalledOnce()
    test.natural()
    test.service.swarm({ ...record, kind: 'swarm', status: 'completed' })
    await Promise.resolve()
    expect(test.start).toHaveBeenCalledTimes(2)
    await test.service.dispose()
  })

  it('does not wake Headless or a shutting-down host', async () => {
    const headless = fixture(false)
    headless.natural()
    headless.service.child(record, 'settled')
    await Promise.resolve()
    expect(headless.start).not.toHaveBeenCalled()
    await headless.service.dispose()
    const desktop = fixture()
    desktop.natural()
    await desktop.service.dispose()
    desktop.service.child(record, 'settled')
    expect(desktop.start).not.toHaveBeenCalled()
  })
})
