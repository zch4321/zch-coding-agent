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
      'Run one read-only model-pool Swarm Job. Call this only when the user explicitly requests a Swarm, multiple Agents, parallel investigation, or independent cross-checking; do not invoke it merely because a task is complex. Every call requires user approval. Provide self-contained tasks because child Agents receive no parent history. Prefer one swarm_run call per assistant turn: multiple Swarm Jobs owned by the same parent Run execute strictly serially and can take a long time. Use agentCount 1 by default, increase it only for independent cross-checking, and request the lowest capability that can complete each task.',
    inputSchema: SwarmRunArgsSchema,
    executionMode: 'serial',
    effects: [],
    defaultRisk: 'review',
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
