import { Type, type Static } from '@sinclair/typebox'
import {
  ClientRequestIdSchema,
  DateTimeSchema,
  DurableSchemaVersionSchema,
  MAX_MESSAGE_PAGE_RECORDS,
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
  MessageSeqSchema,
  Sha256Schema,
} from './durable'
import { ContextAttachmentChipSchema } from './context'
import { CallIdSchema, MessageIdSchema, SessionIdSchema } from './ids'
import { assertBoundedJsonValue, JsonValueSchema } from './json'
import {
  assertModelRouteSnapshotSafe,
  ModelRouteSnapshotSchema,
} from './model-route'

export const CANONICAL_MESSAGE_KINDS = [
  'system_instruction',
  'assistant_preferences',
  'selected_context',
  'runtime_context',
  'agents_context',
  'orchestrator',
  'interjection',
  'user_input',
  'assistant_turn',
  'tool_result',
  'compact_summary',
] as const
export type CanonicalMessageKind = (typeof CANONICAL_MESSAGE_KINDS)[number]
export const CanonicalMessageKindSchema = Type.Unsafe<CanonicalMessageKind>({
  type: 'string',
  enum: [...CANONICAL_MESSAGE_KINDS],
})

export const CANONICAL_PROMPT_KINDS = [
  'system_instruction',
  'assistant_preferences',
  'selected_context',
  'runtime_context',
  'agents_context',
  'orchestrator',
  'interjection',
] as const
export type CanonicalPromptKind = (typeof CANONICAL_PROMPT_KINDS)[number]

export const MESSAGE_VISIBILITIES = ['visible', 'hidden', 'superseded'] as const
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number]
export const MessageVisibilitySchema = Type.Unsafe<MessageVisibility>({
  type: 'string',
  enum: [...MESSAGE_VISIBILITIES],
})

export const PROVIDER_CONTINUATION_SCHEMA_VERSION = 2 as const

export const ProviderContinuationEnvelopeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(PROVIDER_CONTINUATION_SCHEMA_VERSION),
    providerType: Type.String({ minLength: 1, maxLength: 128 }),
    format: Type.String({ minLength: 1, maxLength: 128 }),
    data: JsonValueSchema,
  },
  { additionalProperties: false },
)
export type ProviderContinuationEnvelope = Static<
  typeof ProviderContinuationEnvelopeSchema
>

export const TextPartSchema = Type.Object(
  {
    type: Type.Literal('text'),
    text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_TEXT_LENGTH }),
  },
  { additionalProperties: false },
)
export type TextPart = Static<typeof TextPartSchema>

export const JsonPartSchema = Type.Object(
  {
    type: Type.Literal('json'),
    value: JsonValueSchema,
  },
  { additionalProperties: false },
)
export type JsonPart = Static<typeof JsonPartSchema>

export const ToolCallPartSchema = Type.Object(
  {
    type: Type.Literal('tool_call'),
    callId: CallIdSchema,
    name: Type.String({ minLength: 1, maxLength: 512 }),
    arguments: JsonValueSchema,
  },
  { additionalProperties: false },
)
export type ToolCallPart = Static<typeof ToolCallPartSchema>

export const ToolResultPartSchema = Type.Object(
  {
    type: Type.Literal('tool_result'),
    callId: CallIdSchema,
    content: Type.Array(Type.Union([TextPartSchema, JsonPartSchema]), {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    isError: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type ToolResultPart = Static<typeof ToolResultPartSchema>

export const MessagePartSchema = Type.Union([
  TextPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
])
export type MessagePart = Static<typeof MessagePartSchema>

const AttachmentMetadataSchema = Type.Object(
  {
    ...ContextAttachmentChipSchema.properties,
  },
  { additionalProperties: false },
)

const PromptMetadataSchema = Type.Object(
  {
    resourceId: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    hash: Sha256Schema,
  },
  { additionalProperties: false },
)

const PromptLayerMetadataSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: 512 }),
    trusted: Type.Boolean(),
    editable: Type.Boolean(),
    hash: Sha256Schema,
  },
  { additionalProperties: false },
)

const UsageMetadataSchema = Type.Object(
  {
    inputTokens: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    outputTokens: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    reasoningTokens: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    cachedInputTokens: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
)

const ToolMetadataSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 512 }),
    reason: Type.Optional(Type.String({ maxLength: 16_384 })),
    status: Type.Union([
      Type.Literal('completed'),
      Type.Literal('denied'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('timed_out'),
    ]),
    truncated: Type.Boolean(),
    durationMs: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
)

const ApprovalMetadataSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('approved'), Type.Literal('denied')]),
    source: Type.Union([
      Type.Literal('user'),
      Type.Literal('rule'),
      Type.Literal('model'),
    ]),
  },
  { additionalProperties: false },
)

const CompactMetadataSchema = Type.Object(
  {
    replacesThroughSeq: MessageSeqSchema,
    sourceHash: Sha256Schema,
  },
  { additionalProperties: false },
)

const ReasoningProjectionMetadataSchema = Type.Object(
  {
    truncated: Type.Boolean(),
    omittedOpaqueBlocks: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const UserInputMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    requestHash: Type.Optional(Sha256Schema),
    submission: Type.Union([
      Type.Object(
        { type: Type.Literal('message') },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal('control_command'),
          command: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: '^[a-z][a-z0-9-]*$',
          }),
        },
        { additionalProperties: false },
      ),
    ]),
    attachments: Type.Optional(
      Type.Array(AttachmentMetadataSchema, { maxItems: 64 }),
    ),
  },
  { additionalProperties: false },
)

export const ReplayedUserInputMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    replayedFromMessageId: MessageIdSchema,
    attachments: Type.Optional(
      Type.Array(AttachmentMetadataSchema, { maxItems: 64 }),
    ),
  },
  { additionalProperties: false },
)

export const DerivedUserInputMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    derivedFromMessageId: MessageIdSchema,
    derivation: Type.Literal('control_command_payload'),
  },
  { additionalProperties: false },
)

export const AssistantMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    finishReason: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    usage: Type.Optional(UsageMetadataSchema),
    reasoningProjection: Type.Optional(ReasoningProjectionMetadataSchema),
  },
  { additionalProperties: false },
)

export const ToolResultMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    tool: ToolMetadataSchema,
    approval: Type.Optional(ApprovalMetadataSchema),
  },
  { additionalProperties: false },
)

export const PromptMessageMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    layer: PromptLayerMetadataSchema,
    prompt: Type.Optional(PromptMetadataSchema),
    interjectionId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
  },
  { additionalProperties: false },
)

export const CompactSummaryMetadataV1Schema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    compact: CompactMetadataSchema,
    prompt: Type.Optional(PromptMetadataSchema),
  },
  { additionalProperties: false },
)

export const MessageMetadataV1Schema = Type.Union([
  UserInputMetadataV1Schema,
  ReplayedUserInputMetadataV1Schema,
  DerivedUserInputMetadataV1Schema,
  AssistantMetadataV1Schema,
  ToolResultMetadataV1Schema,
  PromptMessageMetadataV1Schema,
  CompactSummaryMetadataV1Schema,
])
export type MessageMetadataV1 = Static<typeof MessageMetadataV1Schema>

const messageIdentityProperties = {
  schemaVersion: DurableSchemaVersionSchema,
  id: MessageIdSchema,
  sessionId: SessionIdSchema,
  seq: MessageSeqSchema,
  visibility: MessageVisibilitySchema,
  turnId: Type.Optional(MessageIdSchema),
  inHistory: Type.Boolean(),
  createdAt: DateTimeSchema,
}

export const OriginalUserInputMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('user_input'),
    clientRequestId: ClientRequestIdSchema,
    parts: Type.Array(TextPartSchema, {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    metadata: UserInputMetadataV1Schema,
  },
  { additionalProperties: false },
)

export const ReplayedUserInputMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('user_input'),
    parts: Type.Array(TextPartSchema, {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    metadata: ReplayedUserInputMetadataV1Schema,
  },
  { additionalProperties: false },
)

export const DerivedUserInputMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('user_input'),
    parts: Type.Array(TextPartSchema, {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    metadata: DerivedUserInputMetadataV1Schema,
  },
  { additionalProperties: false },
)

export const UserInputMessageRecordSchema = Type.Union([
  OriginalUserInputMessageRecordSchema,
  ReplayedUserInputMessageRecordSchema,
  DerivedUserInputMessageRecordSchema,
])

export const AssistantTurnMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('assistant_turn'),
    parts: Type.Array(Type.Union([TextPartSchema, ToolCallPartSchema]), {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    normalizedReasoningText: Type.Optional(
      Type.String({ maxLength: MAX_MESSAGE_TEXT_LENGTH }),
    ),
    providerContinuation: Type.Optional(ProviderContinuationEnvelopeSchema),
    modelRoute: ModelRouteSnapshotSchema,
    metadata: Type.Optional(AssistantMetadataV1Schema),
  },
  { additionalProperties: false },
)

export const ToolResultMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('tool_result'),
    parts: Type.Tuple([ToolResultPartSchema]),
    metadata: Type.Optional(ToolResultMetadataV1Schema),
  },
  { additionalProperties: false },
)

function textMessageRecordSchema(
  kind:
    | 'system_instruction'
    | 'assistant_preferences'
    | 'selected_context'
    | 'runtime_context'
    | 'agents_context'
    | 'orchestrator'
    | 'interjection',
) {
  return Type.Object(
    {
      ...messageIdentityProperties,
      kind: Type.Literal(kind),
      parts: Type.Array(TextPartSchema, {
        minItems: 1,
        maxItems: MAX_MESSAGE_PARTS,
      }),
      metadata: Type.Optional(PromptMessageMetadataV1Schema),
    },
    { additionalProperties: false },
  )
}

export const SystemInstructionMessageRecordSchema =
  textMessageRecordSchema('system_instruction')
export const AssistantPreferencesMessageRecordSchema = textMessageRecordSchema(
  'assistant_preferences',
)
export const SelectedContextMessageRecordSchema =
  textMessageRecordSchema('selected_context')
export const RuntimeContextMessageRecordSchema =
  textMessageRecordSchema('runtime_context')
export const AgentsContextMessageRecordSchema =
  textMessageRecordSchema('agents_context')
export const OrchestratorMessageRecordSchema =
  textMessageRecordSchema('orchestrator')
export const InterjectionMessageRecordSchema =
  textMessageRecordSchema('interjection')

export const CompactSummaryMessageRecordSchema = Type.Object(
  {
    ...messageIdentityProperties,
    kind: Type.Literal('compact_summary'),
    parts: Type.Array(TextPartSchema, {
      minItems: 1,
      maxItems: MAX_MESSAGE_PARTS,
    }),
    metadata: CompactSummaryMetadataV1Schema,
  },
  { additionalProperties: false },
)

export const MessageRecordSchema = Type.Union([
  UserInputMessageRecordSchema,
  AssistantTurnMessageRecordSchema,
  ToolResultMessageRecordSchema,
  SystemInstructionMessageRecordSchema,
  AssistantPreferencesMessageRecordSchema,
  SelectedContextMessageRecordSchema,
  RuntimeContextMessageRecordSchema,
  AgentsContextMessageRecordSchema,
  OrchestratorMessageRecordSchema,
  InterjectionMessageRecordSchema,
  CompactSummaryMessageRecordSchema,
])
export type MessageRecord = Static<typeof MessageRecordSchema>

/** Identifies user-input records that represent supported control commands with a request ID. */
export function isControlCommandUserInput(
  record: MessageRecord,
): record is Extract<MessageRecord, { kind: 'user_input' }> & {
  clientRequestId: string
  metadata: {
    schemaVersion: 1
    submission: { type: 'control_command'; command: string }
  }
} {
  return (
    record.kind === 'user_input' &&
    'clientRequestId' in record &&
    record.metadata?.submission?.type === 'control_command'
  )
}

const messagePageProperties = {
  schemaVersion: DurableSchemaVersionSchema,
  sessionId: SessionIdSchema,
}

export const MessagePageSchema = Type.Union([
  Type.Object(
    {
      ...messagePageProperties,
      records: Type.Array(MessageRecordSchema, {
        minItems: 1,
        maxItems: MAX_MESSAGE_PAGE_RECORDS,
      }),
      hasMore: Type.Literal(true),
      nextBeforeSeq: MessageSeqSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...messagePageProperties,
      records: Type.Array(MessageRecordSchema, {
        maxItems: MAX_MESSAGE_PAGE_RECORDS,
      }),
      hasMore: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
])
export type MessagePage = Static<typeof MessagePageSchema>

/** Validates visibility, history, sequence, parent, and part invariants for a persisted message. */
export function assertMessageRecordSemantics(record: MessageRecord): void {
  if (record.visibility === 'superseded' && record.inHistory) {
    throw new TypeError('Superseded messages must not enter history')
  }

  if (isControlCommandUserInput(record) && record.inHistory) {
    throw new TypeError('Control command user input must not enter history')
  }

  if (record.kind === 'assistant_turn') {
    assertModelRouteSnapshotSafe(record.modelRoute)
    const callIds = new Set<string>()
    for (const part of record.parts) {
      if (part.type !== 'tool_call') continue
      if (callIds.has(part.callId)) {
        throw new TypeError(`Duplicate assistant tool call id: ${part.callId}`)
      }
      callIds.add(part.callId)
      assertBoundedJsonValue(part.arguments)
    }
    if (record.providerContinuation) {
      assertBoundedJsonValue(record.providerContinuation.data)
    }
    return
  }

  if (record.kind !== 'tool_result') return
  for (const content of record.parts[0].content) {
    if (content.type === 'json') assertBoundedJsonValue(content.value)
  }
}

/** Validates session identity, sequence ordering, and pagination cursors for a message page. */
export function assertMessagePageSemantics(page: MessagePage): void {
  let previousSeq = 0
  for (const record of page.records) {
    if (record.sessionId !== page.sessionId) {
      throw new TypeError('Message page contains a record from another Session')
    }
    if (record.seq <= previousSeq) {
      throw new TypeError('Message page records must be in ascending seq order')
    }
    previousSeq = record.seq
    assertMessageRecordSemantics(record)
  }

  if (page.hasMore && page.nextBeforeSeq !== page.records[0]!.seq) {
    throw new TypeError(
      'Message page nextBeforeSeq must equal the first returned seq',
    )
  }
}
