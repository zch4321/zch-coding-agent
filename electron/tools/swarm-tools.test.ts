import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { ToolRegistry } from './tool-registry'
import { registerSwarmTools } from './swarm-tools'

describe('swarm_run Tool', () => {
  it('registers a serial, Run-scoped Job without a fixed Tool timeout', () => {
    const registry = new ToolRegistry()
    registerSwarmTools(registry, { run: vi.fn() })
    const definition = registry.get('swarm_run')!

    expect(definition.executionMode).toBe('serial')
    expect(definition.defaultTimeoutMs).toBeNull()
    expect(definition.description).toContain('self-contained')
    expect(definition.description).toContain('strictly serially')
  })

  it('forwards ordered task declarations and parent cancellation identity', async () => {
    const run = vi.fn(async () => ({
      results: [],
      meta: {
        status: 'completed' as const,
        agentCount: 1,
        completedCount: 1,
        failedCount: 0,
        durationMs: 1,
        usage: {
          records: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
        },
      },
    }))
    const registry = new ToolRegistry()
    registerSwarmTools(registry, { run })
    const definition = registry.get('swarm_run')!
    const controller = new AbortController()
    const args = {
      tasks: [
        {
          name: 'review',
          task: 'Review the project.',
          requiredCapability: 'standard' as const,
          agentCount: 1,
        },
      ],
    }

    await definition.execute(args, {
      sessionId: 'session:swarm-tool' as SessionId,
      runId: 'run:swarm-tool' as RunId,
      workspace: { canonicalPath: 'F:\\workspace\\fixture' },
      signal: controller.signal,
      approvedCall: {
        sessionId: 'session:swarm-tool' as SessionId,
        runId: 'run:swarm-tool' as RunId,
        callId: 'call:swarm-tool' as CallId,
        toolId: 'swarm_run',
        args,
        approvedBy: 'policy',
        approvedAt: new Date(0).toISOString(),
      } as never,
    })

    expect(run).toHaveBeenCalledWith(args, {
      sessionId: 'session:swarm-tool',
      runId: 'run:swarm-tool',
      callId: 'call:swarm-tool',
      workspace: 'F:\\workspace\\fixture',
      signal: controller.signal,
    })
  })
})
