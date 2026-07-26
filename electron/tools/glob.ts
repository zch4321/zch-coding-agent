function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

/** Normalizes separators and leading slashes for portable glob comparisons. */
export function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** Converts glob wildcards into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePortablePath(pattern || '**/*')
  let source = '^'

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === '*') {
      if (next === '*') {
        const after = normalized[index + 2]
        source += after === '/' ? '(?:.*\\/)?' : '.*'
        index += after === '/' ? 2 : 1
      } else {
        source += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    if (char === '/') {
      source += '\\/'
      continue
    }

    source += escapeRegExp(char)
  }

  source += '$'
  return new RegExp(source)
}

/** Tests a normalized path against a glob pattern. */
export function matchesGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(normalizePortablePath(value))
}
