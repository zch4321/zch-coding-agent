import { Type, type Static } from '@sinclair/typebox'

export const FileChangeRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    conversationId: Type.String({ minLength: 1, maxLength: 256 }),
    sessionId: Type.String({ minLength: 1, maxLength: 128 }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    callId: Type.String({ minLength: 1, maxLength: 128 }),
    workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    operation: Type.Union([
      Type.Literal('write'),
      Type.Literal('patch'),
      Type.Literal('delete'),
    ]),
    diff: Type.String({ maxLength: 262_144 }),
    diffHash: Type.Optional(Type.String({ maxLength: 128 })),
    beforeHash: Type.String({ minLength: 64, maxLength: 64 }),
    afterHash: Type.String({ minLength: 64, maxLength: 64 }),
    createdAt: Type.String({ format: 'date-time' }),
    revertedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
)

export type FileChangeRecord = Static<typeof FileChangeRecordSchema>
