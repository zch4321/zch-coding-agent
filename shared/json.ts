import { Type } from '@sinclair/typebox'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// JSON structural limits are enforced once at IPC/log ingress. Keeping this
// schema reference-free avoids ambiguous recursive refs when contracts compose it.
export const JsonValueSchema = Type.Unsafe<JsonValue>({})
