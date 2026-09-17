import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import { SubagentConversations } from './conversations'
import { SubagentCapacity } from './capacity'
import { ControlAdmission } from './control-admission'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const owner = 'session:owner' as SessionId
const child = 'session:child' as SessionId
const execution = 'agent:initial' as AgentExecutionId
const record = {
  id: execution,
  childSessionId: child,
  parentSessionId: owner,
} as SubagentExecutionRecord
const parent = {
  sessionId: owner,
  runId: 'run:parent' as RunId,
  callId: 'call:one' as CallId,
  workspace: '/workspace',
  signal: new AbortController().signal,
}

describe('process-local child control', () => {
  it('serializes same-child operations and deduplicates only the same call identity', async () => {
    const admission = new ControlAdmission()
    const gate = deferred()
    const first = vi.fn(async () => {
      await gate.promise
      return 1
    })
    const second = vi.fn(async () => 2)
    const a = admission.run('child', 'parent/run/call1', 'send/text', first)
    const duplicate = admission.run(
      'child',
      'parent/run/call1',
      'send/text',
      second,
    )
    const b = admission.run('child', 'parent/run/call2', 'send/text', second)
    expect(a).toBe(duplicate)
    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()
    gate.resolve()
    await expect(a).resolves.toBe(1)
    await expect(b).resolves.toBe(2)
    expect(first).toHaveBeenCalledTimes(1)
    await expect(
      admission.run('child', 'parent/run/call1', 'other', second),
    ).rejects.toThrow('arguments changed')
  })

  it('carries a final-answer race after settlement and protects it from stale-result polling', async () => {
    const gate = deferred()
    let running: { promise: Promise<void> } | undefined = {
      promise: gate.promise,
    }
    const launch = vi.fn(async () => undefined)
    const conversations = new SubagentConversations({
      active: () => running,
      inject: () => false,
      resume: vi.fn(),
      launch,
      failed: vi.fn(),
    })
    conversations.carry(record, parent, [
      {
        id: 'late',
        clientRequestId: 'late',
        runId: 'run:child' as RunId,
        content: 'late text',
        createdAt: new Date().toISOString(),
        status: 'queued',
        parentMessage: { runId: parent.runId, callId: parent.callId },
      },
    ])
    expect(conversations.pending(child)).toBe(1)
    await Promise.resolve()
    expect(launch).not.toHaveBeenCalled()
    running = undefined
    gate.resolve()
    await conversations.settled()
    expect(launch).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ text: 'late text' }),
      expect.any(Function),
    )
    expect(conversations.pending(child)).toBe(0)
  })

  it('injects active messages with resume intent and cancels preparation without starting a successor', async () => {
    const resume = vi.fn()
    let inject = true
    const preparation = deferred()
    let starts = 0
    const conversations = new SubagentConversations({
      active: () => undefined,
      inject: () => inject,
      resume,
      launch: async (_record, _message, wanted) => {
        await preparation.promise
        if (wanted()) starts++
      },
      failed: vi.fn(),
    })
    conversations.send(record, { text: 'active message', parent })
    expect(resume).toHaveBeenCalledOnce()
    inject = false
    conversations.send(record, { text: 'next run', parent })
    await Promise.resolve()
    conversations.cancel(child)
    preparation.resolve()
    await conversations.settled()
    expect(starts).toBe(0)
  })

  it('reserves a whole initial group and admits paused continuations only after capacity is released', async () => {
    const capacity = new SubagentCapacity()
    const second = 'agent:second' as AgentExecutionId
    const third = 'agent:third' as AgentExecutionId
    expect(capacity.reserve(owner, [execution, second], 2)).toBe(true)
    expect(capacity.reserve(owner, [third], 2)).toBe(false)
    const resumed = vi.fn()
    const continuation = capacity
      .acquire(owner, third, 2, new AbortController().signal)
      .then(resumed)
    await Promise.resolve()
    expect(resumed).not.toHaveBeenCalled()
    capacity.release(execution)
    await continuation
    expect(capacity.count(owner)).toBe(2)
    const abort = new AbortController()
    const waiting = capacity.acquire(owner, execution, 2, abort.signal)
    abort.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    capacity.release(second)
    expect(capacity.count(owner)).toBe(1)
  })
})
