import { randomUUID } from 'node:crypto'
import type { CallId, MessageId, RunId, SessionId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import { DomainError, type DomainErrorCode } from '../common/domain-error'

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

/** Raises a deliberate Session failure for application and host adapters to preserve. */
export function sessionFault(
  code: DomainErrorCode,
  message: string,
  details?: JsonObject,
): never {
  throw new DomainError(code, message, { details })
}
