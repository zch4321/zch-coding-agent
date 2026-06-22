import { Type, type Static } from '@sinclair/typebox'
import { PermissionModeSchema } from './config'
import { CallIdSchema, RunIdSchema } from './ids'
import { JsonValueSchema } from './json'
import { LlmUsageRecordSchema } from './usage'

export const ChatMessageSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    role: Type.Union([
      Type.Literal('user'),
      Type.Literal('assistant'),
      Type.Literal('orchestrator'),
    ]),
    runId: Type.Optional(RunIdSchema),
    text: Type.String({ maxLength: 1_000_000 }),
    reasoning: Type.String({ maxLength: 1_000_000 }),
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
)
export type ChatMessage = Static<typeof ChatMessageSchema>

export const ToolActivitySchema = Type.Object(
  {
    callId: CallIdSchema,
    runId: RunIdSchema,
    tool: Type.String({ minLength: 1, maxLength: 128 }),
    args: JsonValueSchema,
    reason: Type.String({ maxLength: 16_384 }),
    status: Type.Union([Type.Literal('proposed'), Type.Literal('completed')]),
    result: Type.Optional(JsonValueSchema),
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
)
export type ToolActivity = Static<typeof ToolActivitySchema>

export const UsageActivitySchema = Type.Object(
  {
    runId: RunIdSchema,
    callId: CallIdSchema,
    usage: LlmUsageRecordSchema,
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
)
export type UsageActivity = Static<typeof UsageActivitySchema>

export const ReviewedApprovalSchema = Type.Object(
  {
    runId: RunIdSchema,
    callId: CallIdSchema,
    tool: Type.String({ minLength: 1, maxLength: 128 }),
    reason: Type.String({ maxLength: 16_384 }),
    diff: Type.String({ maxLength: 250_000 }),
    diffHash: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    decision: Type.Union([
      Type.Literal('allowed'),
      Type.Literal('denied'),
      Type.Literal('stale'),
    ]),
  },
  { additionalProperties: false },
)
export type ReviewedApproval = Static<typeof ReviewedApprovalSchema>

export const OrchestratorEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    text: Type.String({ maxLength: 1_000_000 }),
    createdAt: Type.String({ format: 'date-time' }),
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    promptId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    promptHash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
export type OrchestratorEntry = Static<typeof OrchestratorEntrySchema>

export const ProjectRecordSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    addedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type ProjectRecord = Static<typeof ProjectRecordSchema>

export const ConversationRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    projectPath: Type.String({ minLength: 1, maxLength: 4_096 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    mode: PermissionModeSchema,
    messages: Type.Array(ChatMessageSchema, { maxItems: 10_000 }),
    tools: Type.Optional(Type.Array(ToolActivitySchema, { maxItems: 10_000 })),
    usage: Type.Optional(Type.Array(UsageActivitySchema, { maxItems: 10_000 })),
    orchestratorEntries: Type.Optional(
      Type.Array(OrchestratorEntrySchema, { maxItems: 10_000 }),
    ),
    latestReviewedApproval: Type.Optional(ReviewedApprovalSchema),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type ConversationRecord = Static<typeof ConversationRecordSchema>

export const PersistedWorkbenchSchema = Type.Object(
  {
    projects: Type.Array(ProjectRecordSchema, { maxItems: 512 }),
    conversations: Type.Array(ConversationRecordSchema, { maxItems: 10_000 }),
    activeConversationId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256 }),
    ),
  },
  { additionalProperties: false },
)
export type PersistedWorkbench = Static<typeof PersistedWorkbenchSchema>

export const WorkbenchFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workbench: PersistedWorkbenchSchema,
  },
  { additionalProperties: false },
)
export type WorkbenchFile = Static<typeof WorkbenchFileSchema>
