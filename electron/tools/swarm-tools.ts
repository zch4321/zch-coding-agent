import type { JsonValue } from '../../shared/json'
import { SwarmRunArgsSchema, type SwarmRunArgs } from '../../shared/swarm'
import type { SwarmExecutionPort } from '../swarm/contracts'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'

/** Registers the model-pool Swarm orchestration Tool for eligible public Runs. */
export function registerSwarmTools(
  registry: ToolRegistrationPort,
  execution: SwarmExecutionPort,
): void {
  registry.registerTool({
    id: 'swarm_run',
    description:
      "Run one model-pool Swarm Job. Call this only when the user explicitly requests a Swarm, multiple Agents, parallel work, or independent cross-checking; do not invoke it merely because a task is complex. Child Agents receive no parent history. Put common background, evidence, constraints, and output requirements in sharedContext, and keep every task focused and self-contained. Set each task's toolAccess='readonly' for investigation or toolAccess='inherit' when its Agents must use the parent Run's non-readonly tools and permission mode. Give write-capable tasks disjoint ownership whenever practical. The allocator rotates eligible provider/model identities before reuse, but a limited model pool may still reuse a model. Request the lowest capability that can complete each task.",
    inputSchema: SwarmRunArgsSchema,
    executionMode: 'parallel',
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: null,
    maxOutputBytes: 2_000_000,
    async execute(args: SwarmRunArgs, context): Promise<ToolResult> {
      const result = await execution.run(args, {
        sessionId: context.sessionId,
        runId: context.runId,
        callId: context.approvedCall.callId,
        workspace: context.workspace.canonicalPath,
        signal: context.signal,
      })
      return {
        status: 'ok',
        content: JSON.parse(JSON.stringify(result)) as JsonValue,
      }
    },
  } satisfies ToolDefinition<typeof SwarmRunArgsSchema>)
}
