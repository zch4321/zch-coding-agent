import { Type, type Static } from '@sinclair/typebox'
import { ModelCapabilityLevelSchema } from './config'
import { AgentExecutionUsageSummarySchema } from './agent-execution'
import { ReasoningEffortSchema } from './reasoning'

export const MAX_SWARM_AGENTS = 32
export const MAX_SWARM_TASK_NAME_LENGTH = 64
export const MAX_SWARM_TASK_LENGTH = 32_768

export const SwarmTaskSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: MAX_SWARM_TASK_NAME_LENGTH }),
    task: Type.String({ minLength: 1, maxLength: MAX_SWARM_TASK_LENGTH }),
    requiredCapability: ModelCapabilityLevelSchema,
    agentCount: Type.Integer({ minimum: 1, maximum: MAX_SWARM_AGENTS }),
  },
  { additionalProperties: false },
)
export type SwarmTask = Static<typeof SwarmTaskSchema>

export const SwarmRunArgsSchema = Type.Object(
  {
    tasks: Type.Array(SwarmTaskSchema, {
      minItems: 1,
      maxItems: MAX_SWARM_AGENTS,
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
