import { Type, type Static } from '@sinclair/typebox'
import { IPC_VERSION } from './channels'
import { DiagnosticIdSchema, SessionIdSchema } from './ids'

export const BackendNotificationEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(IPC_VERSION),
    id: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
    }),
    severity: Type.Union([Type.Literal('warning'), Type.Literal('error')]),
    code: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Z][A-Z0-9_]*$',
    }),
    message: Type.String({ minLength: 1, maxLength: 1_024 }),
    occurredAt: Type.String({ format: 'date-time' }),
    sessionId: Type.Optional(SessionIdSchema),
    diagnosticId: Type.Optional(DiagnosticIdSchema),
  },
  { additionalProperties: false },
)

export type BackendNotificationEnvelope = Static<
  typeof BackendNotificationEnvelopeSchema
>
