/** Normalizes separators and leading slashes for portable workspace paths. */
export function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}
