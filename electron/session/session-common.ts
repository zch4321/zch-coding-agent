import { randomUUID } from 'node:crypto'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { IpcFault } from '../ipc'

export { redactJsonSecrets } from '../common/redact-secrets'

/** Creates a typed identifier by combining a prefix with a UUID. */
export function id<Kind extends SessionId | RunId | CallId | MessageId>(
  prefix: string,
): Kind {
  return `${prefix}-${randomUUID()}` as Kind
}

/** Converts an unknown value to the repository's JSON-safe representation. */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Creates a normalized IPC fault payload from an error code, message, and safe details. */
export function ipcFault(
  code:
    | 'PRECONDITION_FAILED'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'CANCELLED'
    | 'INTERNAL_ERROR',
  message: string,
  details?: JsonValue,
): never {
  throw new IpcFault({ code, message, details })
}
