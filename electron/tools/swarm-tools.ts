import { SwarmRunArgsSchema, type SwarmRunArgs } from '../../shared/swarm'
import type { SwarmExecutionPort } from '../swarm/contracts'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'
import type { JsonValue } from '../../shared/json'

/** Registers the model-pool Swarm orchestration Tool for eligible public Runs. */
export function registerSwarmTools(
  registry: ToolRegistrationPort,
  execution: SwarmExecutionPort,
): void {
  registry.registerTool({
    id: 'swarm_run',
    description:
      "Start one background model-pool Swarm and immediately return a process-local numeric target. Call this only when the user explicitly requests a Swarm, multiple Agents, parallel work, or independent cross-checking. Child Agents receive no parent history, so every task must be self-contained. Put common background and constraints in sharedContext, and give write-capable tasks disjoint ownership. Set toolAccess='readonly' for investigation or toolAccess='inherit' for frozen parent permissions. Use background_wait/list to observe completion and obtain child targets; read the manifest and child artifacts for complete results.",
    inputSchema: SwarmRunArgsSchema,
    executionMode: 'parallel',
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 30_000,
    async execute(args: SwarmRunArgs, context): Promise<ToolResult> {
      const run =
        execution.start?.bind(execution) ?? execution.run.bind(execution)
      const result = await run(args, {
        sessionId: context.sessionId,
        runId: context.runId,
        callId: context.approvedCall.callId,
        workspace: context.workspace.canonicalPath,
        signal: context.signal,
        ...(context.ownerSessionId
          ? { ownerSessionId: context.ownerSessionId }
          : {}),
        ...(context.sessionTemp ? { sessionTemp: context.sessionTemp } : {}),
        ...(context.maxSubagents ? { maxSubagents: context.maxSubagents } : {}),
      })
      return {
        status: 'ok',
        content: JSON.parse(JSON.stringify(result)) as JsonValue,
      }
    },
  } satisfies ToolDefinition<typeof SwarmRunArgsSchema>)
}
