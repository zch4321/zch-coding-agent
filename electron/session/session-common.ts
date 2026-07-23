import { randomUUID } from 'node:crypto'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { IpcFault } from '../ipc'

export function id<Kind extends SessionId | RunId | CallId | MessageId>(
  prefix: string,
): Kind {
  return `${prefix}-${randomUUID()}` as Kind
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function redactJsonSecrets(
  value: JsonValue,
  secrets: readonly string[],
): JsonValue {
  const present = secrets.filter((secret) => secret.length > 0)
  if (typeof value === 'string') {
    return present.reduce(
      (current, secret) => current.split(secret).join('[redacted]'),
      value,
    )
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonSecrets(item, present))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactJsonSecrets(nested, present),
      ]),
    )
  }
  return value
}

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
