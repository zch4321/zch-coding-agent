import picomatch from 'picomatch'
import { normalizePortablePath } from '../tools/portable-path'

/** Compiles one configured sensitive-path glob into a portable path matcher. */
export function createSensitivePathMatcher(
  pattern: string,
): (candidate: string) => boolean {
  const matcher = picomatch(normalizePortablePath(pattern), {
    dot: true,
    maxLength: 1_024,
    nocase: process.platform === 'win32',
    nonegate: true,
    posix: true,
    strictBrackets: true,
  })

  return (candidate) => matcher(normalizePortablePath(candidate))
}
