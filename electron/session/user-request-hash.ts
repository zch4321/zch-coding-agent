import { canonicalHash } from './canonical-history'

/** Includes ordered immutable attachment references in user-request idempotency. */
export function userRequestHash(
  message: string,
  attachmentIds: readonly string[] = [],
): string {
  return canonicalHash(
    attachmentIds.length ? { message, attachmentIds } : message,
  )
}
