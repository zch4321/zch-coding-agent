import { describe, expect, it } from 'vitest'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import { BackgroundAgentHandleRegistry } from './agent-handle-registry'

describe('BackgroundAgentHandleRegistry', () => {
  it('keeps one numeric handle per execution within the current process registry', () => {
    const registry = new BackgroundAgentHandleRegistry()
    const registration = {
      executionId: 'subagent:one' as AgentExecutionId,
      parentSessionId: 'session:one' as SessionId,
      type: 'subagent' as const,
    }
    const first = registry.expose(registration)
    const repeated = registry.expose(registration)
    const second = registry.expose({
      ...registration,
      executionId: 'subagent:two' as AgentExecutionId,
    })

    expect(first).toBeGreaterThan(0)
    expect(repeated).toBe(first)
    expect(second).toBeGreaterThan(first)
    expect(
      registry.resolve({
        id: first,
        parentSessionId: registration.parentSessionId,
        type: registration.type,
      }),
    ).toBe(registration.executionId)
  })

  it('rejects handles from another Session, kind, or registry instance', () => {
    const registry = new BackgroundAgentHandleRegistry()
    const id = registry.expose({
      executionId: 'swarm:one' as AgentExecutionId,
      parentSessionId: 'session:one' as SessionId,
      type: 'swarm',
    })

    expect(
      registry.resolve({
        id,
        parentSessionId: 'session:other' as SessionId,
        type: 'swarm',
      }),
    ).toBeUndefined()
    expect(
      registry.resolve({
        id,
        parentSessionId: 'session:one' as SessionId,
        type: 'subagent',
      }),
    ).toBeUndefined()
    expect(
      new BackgroundAgentHandleRegistry().resolve({
        id,
        parentSessionId: 'session:one' as SessionId,
        type: 'swarm',
      }),
    ).toBeUndefined()
  })
})
