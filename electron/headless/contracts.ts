import { Type, type Static } from '@sinclair/typebox'
import {
  AgentEventSchema,
  TerminalEventSchema,
} from '../../shared/agent-events'
import {
  ProviderTypeSchema,
  PublicConfigSchema,
  ReasoningEffortSchema,
} from '../../shared/config'
import { RunIdSchema, SessionIdSchema } from '../../shared/ids'
import { McpServerConfigSchema } from '../../shared/mcp'

const HeadlessProviderConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    providerType: ProviderTypeSchema,
    baseURL: Type.String({ minLength: 1, maxLength: 2_048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: Type.Optional(ReasoningEffortSchema),
    credentialEnv: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
    }),
  },
  { additionalProperties: false },
)

const LegacyHeadlessProviderConfigV1Schema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    protocol: Type.Optional(Type.Literal('openai-compatible')),
    profile: Type.Optional(
      Type.Union([Type.Literal('deepseek'), Type.Literal('generic')]),
    ),
    baseURL: Type.String({ minLength: 1, maxLength: 2_048 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    reasoning: Type.Optional(ReasoningEffortSchema),
    credentialEnv: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
    }),
  },
  { additionalProperties: false },
)

const HeadlessUsageSchema = Type.Object(
  {
    records: Type.Integer({ minimum: 0 }),
    promptTokens: Type.Integer({ minimum: 0 }),
    completionTokens: Type.Integer({ minimum: 0 }),
    reasoningTokens: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    cacheHitTokens: Type.Integer({ minimum: 0 }),
    cacheMissTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)

const HeadlessToolTotalsSchema = Type.Object(
  {
    proposed: Type.Integer({ minimum: 0 }),
    completed: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)

const LegacyHeadlessLimitsWithRunToolBudgetSchema = Type.Partial(
  Type.Object(
    {
      ...PublicConfigSchema.properties.limits.properties,
      maxToolTokensPerRun: Type.Integer({
        minimum: 256,
        maximum: 10_000_000,
      }),
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
)

// Headless v4 predates Swarm and keeps its original Subagent shape. Internal
// AppConfig fills the v19 Swarm cardinality default during preparation.
const HeadlessSubagentsConfigV4Schema = Type.Object(
  {
    enabled: Type.Boolean(),
    workerTimeoutMs: Type.Integer({
      minimum: 60_000,
      maximum: 86_400_000,
    }),
  },
  { additionalProperties: false },
)

export const HeadlessConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(4),
    provider: HeadlessProviderConfigSchema,
    limits: Type.Optional(
      Type.Partial(PublicConfigSchema.properties.limits, {
        additionalProperties: false,
      }),
    ),
    assistant: Type.Optional(
      Type.Partial(PublicConfigSchema.properties.assistant, {
        additionalProperties: false,
      }),
    ),
    skills: Type.Optional(
      Type.Partial(PublicConfigSchema.properties.skills, {
        additionalProperties: false,
      }),
    ),
    subagents: Type.Optional(HeadlessSubagentsConfigV4Schema),
    network: Type.Optional(PublicConfigSchema.properties.network),
    mcpServers: Type.Optional(
      Type.Array(McpServerConfigSchema, { maxItems: 32 }),
    ),
    maxAutoPlanApprovals: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 8 }),
    ),
  },
  { additionalProperties: false },
)
export type HeadlessConfig = Static<typeof HeadlessConfigSchema>

export const LegacyHeadlessConfigV3Schema = Type.Object(
  {
    ...HeadlessConfigSchema.properties,
    schemaVersion: Type.Literal(3),
    limits: Type.Optional(LegacyHeadlessLimitsWithRunToolBudgetSchema),
  },
  { additionalProperties: false },
)
export type LegacyHeadlessConfigV3 = Static<typeof LegacyHeadlessConfigV3Schema>

export const LegacyHeadlessConfigV2Schema = Type.Object(
  {
    ...LegacyHeadlessConfigV3Schema.properties,
    schemaVersion: Type.Literal(2),
    subagents: Type.Optional(Type.Never()),
  },
  { additionalProperties: false },
)
export type LegacyHeadlessConfigV2 = Static<typeof LegacyHeadlessConfigV2Schema>

export const LegacyHeadlessConfigV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    provider: LegacyHeadlessProviderConfigV1Schema,
    limits: Type.Optional(LegacyHeadlessLimitsWithRunToolBudgetSchema),
    assistant: HeadlessConfigSchema.properties.assistant,
    skills: HeadlessConfigSchema.properties.skills,
    network: HeadlessConfigSchema.properties.network,
    mcpServers: HeadlessConfigSchema.properties.mcpServers,
    maxAutoPlanApprovals: HeadlessConfigSchema.properties.maxAutoPlanApprovals,
  },
  { additionalProperties: false },
)
export type LegacyHeadlessConfigV1 = Static<typeof LegacyHeadlessConfigV1Schema>

export const HeadlessRunStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed_out'),
  Type.Literal('needs_human_input'),
])
export type HeadlessRunStatus = Static<typeof HeadlessRunStatusSchema>

export const HeadlessResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    status: HeadlessRunStatusSchema,
    sessionId: SessionIdSchema,
    runIds: Type.Array(RunIdSchema, { minItems: 1, maxItems: 16 }),
    startedAt: Type.String({ format: 'date-time' }),
    completedAt: Type.String({ format: 'date-time' }),
    durationMs: Type.Number({ minimum: 0 }),
    finalResponse: Type.Optional(Type.String({ maxLength: 1_000_000 })),
    incompleteReason: Type.Optional(
      Type.Union([
        Type.Literal('goal_blocked'),
        Type.Literal('plan_approval_limit'),
        Type.Literal('plan_approval_failed'),
      ]),
    ),
    configHash: Type.String({ minLength: 64, maxLength: 64 }),
    autoPlanApprovals: Type.Integer({ minimum: 0, maximum: 8 }),
    usage: HeadlessUsageSchema,
    tools: HeadlessToolTotalsSchema,
    artifacts: Type.Object(
      {
        resultPath: Type.String({ minLength: 1, maxLength: 4_096 }),
        identityPath: Type.String({ minLength: 1, maxLength: 4_096 }),
        tracePath: Type.String({ minLength: 1, maxLength: 4_096 }),
        patchPath: Type.Optional(
          Type.String({ minLength: 1, maxLength: 4_096 }),
        ),
        patchStatus: Type.Union([
          Type.Literal('written'),
          Type.Literal('not_git'),
          Type.Literal('failed'),
        ]),
      },
      { additionalProperties: false },
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 128 }),
          message: Type.String({ maxLength: 65_536 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type HeadlessResult = Static<typeof HeadlessResultSchema>

const HeadlessEventBaseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  seq: Type.Integer({ minimum: 1 }),
  ts: Type.String({ format: 'date-time' }),
})

export const HeadlessStreamEventSchema = Type.Union([
  Type.Composite([
    HeadlessEventBaseSchema,
    Type.Object({
      type: Type.Literal('runtime.started'),
      workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      model: Type.String({ minLength: 1, maxLength: 256 }),
      permissionMode: Type.Literal('yolo'),
      configHash: Type.String({ minLength: 64, maxLength: 64 }),
    }),
  ]),
  Type.Composite([
    HeadlessEventBaseSchema,
    Type.Object({ type: Type.Literal('agent.event'), event: AgentEventSchema }),
  ]),
  Type.Composite([
    HeadlessEventBaseSchema,
    Type.Object({
      type: Type.Literal('terminal.event'),
      event: TerminalEventSchema,
    }),
  ]),
  Type.Composite([
    HeadlessEventBaseSchema,
    Type.Object({
      type: Type.Literal('harness.auto_action'),
      action: Type.Literal('plan_approved'),
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      promptId: Type.String({ minLength: 1, maxLength: 256 }),
      promptHash: Type.String({ minLength: 64, maxLength: 64 }),
    }),
  ]),
  Type.Composite([
    HeadlessEventBaseSchema,
    Type.Object({
      type: Type.Literal('runtime.completed'),
      status: HeadlessRunStatusSchema,
      resultPath: Type.String({ minLength: 1, maxLength: 4_096 }),
    }),
  ]),
])
export type HeadlessStreamEvent = Static<typeof HeadlessStreamEventSchema>

export type HeadlessStreamEventDraft = HeadlessStreamEvent extends infer Event
  ? Event extends HeadlessStreamEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never
