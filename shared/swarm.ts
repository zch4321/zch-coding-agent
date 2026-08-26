import { Type, type Static } from '@sinclair/typebox'
import { ModelCapabilityLevelSchema } from './config/providers'
import { AgentExecutionUsageSummarySchema } from './agent-execution'
import { ReasoningEffortSchema } from './reasoning'
import { AgentToolAccessSchema } from './agent-execution'

export const MAX_SWARM_AGENTS = 32
export const MAX_SWARM_SHARED_CONTEXT_LENGTH = 32_768
export const MAX_SWARM_TASK_NAME_LENGTH = 64
export const MAX_SWARM_TASK_LENGTH = 32_768

export const SwarmTaskSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: MAX_SWARM_TASK_NAME_LENGTH,
      description: 'Short unique name for this investigation task.',
    }),
    task: Type.String({
      minLength: 1,
      maxLength: MAX_SWARM_TASK_LENGTH,
      description:
        'Child-specific assignment. Do not repeat background or verification already supplied in sharedContext.',
    }),
    requiredCapability: Type.Unsafe<Static<typeof ModelCapabilityLevelSchema>>({
      ...ModelCapabilityLevelSchema,
      description:
        'Lowest model capability sufficient for this task: light, standard, or strong.',
    }),
    agentCount: Type.Integer({
      minimum: 1,
      maximum: MAX_SWARM_AGENTS,
      description:
        'Number of independent replicas for this task. Use multiple replicas for cross-model verification.',
    }),
    toolAccess: Type.Unsafe<Static<typeof AgentToolAccessSchema>>({
      ...AgentToolAccessSchema,
      description:
        "Tool access for every replica of this task. Use 'readonly' for investigation and 'inherit' only when the task needs the parent Run's non-readonly tools and permission mode.",
    }),
  },
  { additionalProperties: false },
)
export type SwarmTask = Static<typeof SwarmTaskSchema>

export const SwarmRunArgsSchema = Type.Object(
  {
    sharedContext: Type.String({
      minLength: 1,
      maxLength: MAX_SWARM_SHARED_CONTEXT_LENGTH,
      description:
        'Common background injected into every child Agent. Include relevant verification commands, exit codes, and concise key output; explicitly state when verification could not be run.',
    }),
    tasks: Type.Array(SwarmTaskSchema, {
      minItems: 1,
      maxItems: MAX_SWARM_AGENTS,
      description:
        'Independent assignments. The total of all agentCount values must stay within the protocol Agent limit.',
    }),
  },
  { additionalProperties: false },
)
export type SwarmRunArgs = Static<typeof SwarmRunArgsSchema>

export const SwarmAgentResultSchema = Type.Object(
  {
    taskIndex: Type.Integer({ minimum: 0, maximum: MAX_SWARM_AGENTS - 1 }),
    agentIndex: Type.Integer({ minimum: 1, maximum: MAX_SWARM_AGENTS }),
    name: Type.String({ minLength: 1, maxLength: MAX_SWARM_TASK_NAME_LENGTH }),
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('timed_out'),
    ]),
    response: Type.Optional(Type.String({ maxLength: 2_000_000 })),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 128 }),
          message: Type.String({ maxLength: 65_536 }),
        },
        { additionalProperties: false },
      ),
    ),
    assignment: Type.Object(
      {
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        model: Type.String({ minLength: 1, maxLength: 256 }),
        reasoning: ReasoningEffortSchema,
        capability: ModelCapabilityLevelSchema,
      },
      { additionalProperties: false },
    ),
    durationMs: Type.Number({ minimum: 0 }),
    usage: AgentExecutionUsageSummarySchema,
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type SwarmAgentResult = Static<typeof SwarmAgentResultSchema>

export const SwarmRunResultSchema = Type.Object(
  {
    results: Type.Array(SwarmAgentResultSchema, {
      minItems: 1,
      maxItems: MAX_SWARM_AGENTS,
    }),
    meta: Type.Object(
      {
        status: Type.Union([
          Type.Literal('completed'),
          Type.Literal('partial'),
        ]),
        agentCount: Type.Integer({ minimum: 1, maximum: MAX_SWARM_AGENTS }),
        completedCount: Type.Integer({ minimum: 0, maximum: MAX_SWARM_AGENTS }),
        failedCount: Type.Integer({ minimum: 0, maximum: MAX_SWARM_AGENTS }),
        durationMs: Type.Number({ minimum: 0 }),
        usage: AgentExecutionUsageSummarySchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type SwarmRunResult = Static<typeof SwarmRunResultSchema>
