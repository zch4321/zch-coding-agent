import { Type, type Static } from '@sinclair/typebox'
import { EventIdSchema, RunIdSchema, SessionIdSchema } from './ids'
import { JsonValueSchema } from './json'
import { TraceIdSchema } from './trace'

export const SESSION_TRANSCRIPT_FORMAT = 'zch-session-transcript'
export const SESSION_TRANSCRIPT_SCHEMA_VERSION = 1

export const SessionTranscriptCategorySchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('reasoning'),
  Type.Literal('internal'),
  Type.Literal('tool'),
  Type.Literal('approval'),
  Type.Literal('provider'),
  Type.Literal('runtime'),
  Type.Literal('terminal'),
])
export type SessionTranscriptCategory = Static<
  typeof SessionTranscriptCategorySchema
>

export const SessionTranscriptKindSchema = Type.Union([
  Type.Literal('session'),
  Type.Literal('run'),
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('reasoning'),
  Type.Literal('orchestrator'),
  Type.Literal('tool'),
  Type.Literal('interjection'),
  Type.Literal('plan'),
  Type.Literal('usage'),
  Type.Literal('terminal'),
  Type.Literal('provider_request'),
  Type.Literal('provider_response'),
  Type.Literal('runtime'),
])
export type SessionTranscriptKind = Static<typeof SessionTranscriptKindSchema>

export const SessionTranscriptMetadataSchema = Type.Object(
  {
    schemaVersion: Type.Literal(SESSION_TRANSCRIPT_SCHEMA_VERSION),
    format: Type.Literal(SESSION_TRANSCRIPT_FORMAT),
    importable: Type.Literal(false),
    classification: Type.Literal('restricted'),
    traceId: TraceIdSchema,
    revision: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.Optional(SessionIdSchema),
    workspace: Type.Optional(Type.String({ maxLength: 4_096 })),
    model: Type.Optional(Type.String({ maxLength: 256 })),
    mode: Type.Optional(Type.String({ maxLength: 64 })),
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
    endedAt: Type.Optional(Type.String({ format: 'date-time' })),
    generatedAt: Type.String({ format: 'date-time' }),
    lastSeq: Type.Integer({ minimum: 0 }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type SessionTranscriptMetadata = Static<
  typeof SessionTranscriptMetadataSchema
>

export const SessionTranscriptEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    seq: Type.Integer({ minimum: 1 }),
    ts: Type.String({ format: 'date-time' }),
    kind: SessionTranscriptKindSchema,
    categories: Type.Array(SessionTranscriptCategorySchema, {
      minItems: 1,
      maxItems: 4,
    }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    runId: Type.Optional(RunIdSchema),
    callId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    requestEventId: Type.Optional(EventIdSchema),
    text: Type.Optional(Type.String({ maxLength: 32 * 1_024 * 1_024 })),
    data: Type.Optional(JsonValueSchema),
    partial: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export type SessionTranscriptEntry = Static<typeof SessionTranscriptEntrySchema>

export const SessionTranscriptPageSchema = Type.Object(
  {
    metadata: SessionTranscriptMetadataSchema,
    total: Type.Integer({ minimum: 0 }),
    entries: Type.Array(SessionTranscriptEntrySchema, { maxItems: 100 }),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  },
  { additionalProperties: false },
)
export type SessionTranscriptPage = Static<typeof SessionTranscriptPageSchema>

export const SessionTranscriptRequestMessagesPageSchema = Type.Object(
  {
    traceId: TraceIdSchema,
    revision: Type.String({ minLength: 1, maxLength: 128 }),
    requestEventId: EventIdSchema,
    total: Type.Integer({ minimum: 0 }),
    messages: Type.Array(JsonValueSchema, { maxItems: 25 }),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
  },
  { additionalProperties: false },
)
export type SessionTranscriptRequestMessagesPage = Static<
  typeof SessionTranscriptRequestMessagesPageSchema
>
