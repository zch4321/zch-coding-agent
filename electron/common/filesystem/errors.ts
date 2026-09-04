/** Returns whether a Node filesystem error carries the requested error code. */
export function hasFileErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code,
  )
}

/** Returns whether a filesystem operation failed because its target is absent. */
export function isMissingFileError(error: unknown): boolean {
  return hasFileErrorCode(error, 'ENOENT')
}
