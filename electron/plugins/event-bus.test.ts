import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { PluginEventBus } from './event-bus'

const sessionId = 'session-1' as SessionId
const runId = 'run-1' as RunId
const callId = 'call-1' as CallId

describe('PluginEventBus', () => {
  it('collects explicit LLM patches without sharing mutable context', async () => {
    const bus = new PluginEventBus()
    bus.on('beforeLLMCall', (context) => {
      expect(Object.isFrozen(context)).toBe(true)
      expect(Object.isFrozen(context.messages)).toBe(true)
      return { patch: { params: { temperature: 0 } } }
    })

    const result = await bus.emit('beforeLLMCall', {
      version: 1,
      sessionId,
      runId,
      messages: [{ role: 'user', text: 'hello' }],
      params: { temperature: 1 },
    })

    expect(result.patches).toEqual([{ params: { temperature: 0 } }])
  })

  it('fails closed when beforeToolCall throws or times out', async () => {
    const throwing = new PluginEventBus()
    throwing.on('beforeToolCall', () => {
      throw new Error('blocked by plugin')
    })
    const context = {
      version: 1 as const,
      sessionId,
      runId,
      call: {
        id: callId,
        toolId: 'write_file',
        args: { path: 'a.txt' },
        reason: 'write output',
      },
      currentRisk: 'review' as const,
    }

    await expect(
      throwing.emit('beforeToolCall', context),
    ).resolves.toMatchObject({
      allow: false,
    })

    const timeout = new PluginEventBus({ timeoutMs: 10 })
    timeout.on('beforeToolCall', () => new Promise(() => undefined))
    await expect(
      timeout.emit('beforeToolCall', context),
    ).resolves.toMatchObject({
      allow: false,
    })
  })

  it('isolates observation hook failures and only raises tool risk', async () => {
    const bus = new PluginEventBus()
    bus.on('onSessionStart', () => {
      throw new Error('diagnostic only')
    })
    bus.on('beforeToolCall', () => ({ raiseRisk: 'high' }))

    const observation = await bus.emit('onSessionStart', {
      version: 1,
      sessionId,
      workspace: 'F:/workspace',
      mode: 'auto',
    })
    const decision = await bus.emit('beforeToolCall', {
      version: 1,
      sessionId,
      runId,
      call: {
        id: callId,
        toolId: 'read_file',
        args: { path: 'README.md' },
        reason: '',
      },
      currentRisk: 'low',
    })

    expect(observation.diagnostics).toHaveLength(1)
    expect(decision).toMatchObject({ allow: true, risk: 'high' })
  })
})
