import { randomUUID } from 'node:crypto'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { IpcFault } from '../ipc'

export function id<Kind extends SessionId | RunId | CallId>(
  prefix: string,
): Kind {
  return `${prefix}-${randomUUID()}` as Kind
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
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
