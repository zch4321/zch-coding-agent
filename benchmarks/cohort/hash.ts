import { sha256Bytes } from '../cases/hash'

/** Hashes a value after canonicalizing object key order and nested values. */
export function sha256Canonical(value: unknown): string {
  return sha256Bytes(JSON.stringify(canonicalize(value)))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  )
}
