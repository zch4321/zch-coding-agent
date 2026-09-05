import { Type, type Static } from '@sinclair/typebox'

export const RuntimeCursorSchema = Type.Object(
  {
    backendInstanceId: Type.String({ minLength: 1, maxLength: 256 }),
    sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)
export type RuntimeCursor = Static<typeof RuntimeCursorSchema>
