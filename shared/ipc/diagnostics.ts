import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import {
  SessionTranscriptPageSchema,
  SessionTranscriptRequestMessagesPageSchema,
} from '../session-transcript'
import {
  EventIdSchema,
  ProviderStatsSchema,
  ReplaySummarySchema,
  TraceIdSchema,
  TraceInfoSchema,
} from '../trace'
import { AcceptedSchema, EmptyPayloadSchema, ipcResultSchema } from './common'

export const DIAGNOSTICS_IPC_CONTRACTS = {
  'trace:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(Type.Array(TraceInfoSchema, { maxItems: 1_000 })),
  },
  'trace:replay': {
    payload: Type.Object(
      { version: Type.Literal(IPC_VERSION), traceId: TraceIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ReplaySummarySchema),
  },
  'trace:transcript-page': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(SessionTranscriptPageSchema),
  },
  'trace:request-messages': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        requestEventId: EventIdSchema,
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(SessionTranscriptRequestMessagesPageSchema),
  },
  'trace:export-transcript': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: TraceIdSchema,
        confirmed: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          canceled: Type.Boolean(),
          path: Type.Optional(Type.String({ maxLength: 4_096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'trace:stats': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        traceId: Type.Optional(TraceIdSchema),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProviderStatsSchema),
  },
  'logs:open-directory': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'logs:clear-closed': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        { deleted: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
  },
} as const
