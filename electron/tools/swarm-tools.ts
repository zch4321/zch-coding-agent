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
      'Run one read-only model-pool Swarm Job. Call this only when the user explicitly requests a Swarm, multiple Agents, parallel investigation, or independent cross-checking; do not invoke it merely because a task is complex. Every call requires user approval. Child Agents receive no parent history and cannot execute commands, builds, or tests. Before calling, run relevant verification with parent command tools when feasible, then put each command, exit code, and concise key output in sharedContext; explicitly state there when verification could not be run. Put common background, evidence, constraints, and output requirements in sharedContext, and keep each task focused on its Child-specific assignment; together they must be self-contained. When independent cross-checking adds value, use close to the per-Job Agent limit and assign multiple Agents to the same task; the allocator rotates eligible provider/model identities before reuse, but a limited model pool may still reuse a model. Prefer one swarm_run call per assistant turn because multiple Swarm Jobs owned by the same parent Run execute strictly serially and can take a long time. Request the lowest capability that can complete each task.',
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
