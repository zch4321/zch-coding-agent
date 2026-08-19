import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { JsonValueSchema } from '../json'

export const IpcErrorSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal('INVALID_SENDER'),
      Type.Literal('INVALID_PAYLOAD'),
      Type.Literal('PAYLOAD_TOO_LARGE'),
      Type.Literal('NOT_AVAILABLE'),
      Type.Literal('PRECONDITION_FAILED'),
      Type.Literal('CONFLICT'),
      Type.Literal('NOT_FOUND'),
      Type.Literal('CANCELLED'),
      Type.Literal('RESOURCE_CHANGED'),
      Type.Literal('PERSISTENCE_FAILURE'),
      Type.Literal('SECRET_STORAGE_UNAVAILABLE'),
      Type.Literal('INTERNAL_ERROR'),
    ]),
    message: Type.String({ maxLength: 4_096 }),
    details: Type.Optional(JsonValueSchema),
  },
  { additionalProperties: false },
)
export type IpcError = Static<typeof IpcErrorSchema>

/** Wraps a successful value schema in the shared IPC success/error envelope. */
export function ipcResultSchema<ValueSchema extends TSchema>(
  value: ValueSchema,
) {
  return Type.Union([
    Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        ok: Type.Literal(true),
        value,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        ok: Type.Literal(false),
        error: IpcErrorSchema,
      },
      { additionalProperties: false },
    ),
  ])
}

/** Adapts a durable domain-state contract to the shared IPC result envelope. */
export function domainIpcContract<
  PayloadSchema extends TSchema,
  ResultSchema extends TSchema,
>(contract: { payload: PayloadSchema; result: ResultSchema }) {
  return {
    payload: contract.payload,
    result: ipcResultSchema(contract.result),
  }
}

export const EmptyPayloadSchema = Type.Object(
  { version: Type.Literal(IPC_VERSION) },
  { additionalProperties: false },
)

export const AcceptedSchema = Type.Object(
  { accepted: Type.Boolean() },
  { additionalProperties: false },
)
