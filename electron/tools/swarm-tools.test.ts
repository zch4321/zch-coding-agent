import { describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../shared/config'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { evaluatePolicy } from '../permission/policy-engine'
import { ToolRegistry } from './tool-registry'
import { registerSwarmTools } from './swarm-tools'

describe('swarm_run Tool', () => {
  it('registers a parallel, low-risk orchestration Tool without a fixed timeout', () => {
    const registry = new ToolRegistry()
    registerSwarmTools(registry, { run: vi.fn() })
    const definition = registry.get('swarm_run')!

    expect(definition.executionMode).toBe('parallel')
    expect(definition.defaultRisk).toBe('low')
    expect(definition.defaultTimeoutMs).toBeNull()
    expect(definition.description).toContain('user explicitly requests')
    expect(definition.description).toContain('self-contained')
    expect(definition.description).toContain("toolAccess='readonly'")
    expect(definition.description).toContain("toolAccess='inherit'")
    expect(definition.description).toContain('disjoint ownership')
    expect(definition.description).not.toContain('agentCount 1 by default')
  })

  it.each<PermissionMode>(['readonly', 'auto', 'confirm', 'yolo'])(
    'allows low-risk orchestration in %s mode',
    (mode) => {
      const registry = new ToolRegistry()
      registerSwarmTools(registry, { run: vi.fn() })
      const definition = registry.get('swarm_run')!

      expect(
        evaluatePolicy({
          mode,
          definition,
          effectiveRisk: definition.defaultRisk,
          policySignals: [],
          rememberedRules: [],
          builtinPolicies: true,
          workspace: 'F:\\workspace\\fixture',
          args: { sharedContext: 'Verification was not run.', tasks: [] },
          callId: 'call:swarm-review' as CallId,
        }).kind,
      ).toBe('allow')
    },
  )

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
      sharedContext: 'npm run check exited 0 with no failures.',
      tasks: [
        {
          name: 'review',
          task: 'Review the project.',
          requiredCapability: 'standard' as const,
          agentCount: 1,
          toolAccess: 'inherit' as const,
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
