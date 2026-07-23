import { Type } from '@sinclair/typebox'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// This legacy-compatible schema stays reference-free so existing IPC/log
// contracts can compose it. Canonical durable boundaries must additionally call
// assertBoundedJsonValue() instead of treating this structural type as a limit.
export const JsonValueSchema = Type.Unsafe<JsonValue>({})

export interface JsonValueLimits {
  maxDepth: number
  maxArrayLength: number
  maxObjectKeys: number
  maxStringLength: number
  maxBytes: number
  maxNodes?: number
}

export const CANONICAL_JSON_LIMITS: JsonValueLimits = {
  maxDepth: 32,
  maxArrayLength: 1_024,
  maxObjectKeys: 256,
  maxStringLength: 1_000_000,
  maxBytes: 2_000_000,
  maxNodes: 100_000,
}

export function assertBoundedJsonValue(
  value: unknown,
  limits: JsonValueLimits = CANONICAL_JSON_LIMITS,
): asserts value is JsonValue {
  const active = new Set<object>()
  const maxNodes = limits.maxNodes ?? CANONICAL_JSON_LIMITS.maxNodes!
  let visitedNodes = 0

  function visit(candidate: unknown, depth: number): void {
    visitedNodes += 1
    if (visitedNodes > maxNodes) {
      throw new RangeError(`JSON value exceeds maximum node count ${maxNodes}`)
    }
    if (depth > limits.maxDepth) {
      throw new RangeError(
        `JSON value exceeds maximum depth ${limits.maxDepth}`,
      )
    }

    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'string'
    ) {
      if (
        typeof candidate === 'string' &&
        candidate.length > limits.maxStringLength
      ) {
        throw new RangeError(
          `JSON string exceeds maximum length ${limits.maxStringLength}`,
        )
      }
      return
    }

    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('JSON numbers must be finite')
      }
      return
    }

    if (typeof candidate !== 'object') {
      throw new TypeError('Value is not JSON-compatible')
    }

    if (active.has(candidate)) {
      throw new TypeError('JSON value must not contain cycles')
    }
    active.add(candidate)

    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > limits.maxArrayLength) {
          throw new RangeError(
            `JSON array exceeds maximum length ${limits.maxArrayLength}`,
          )
        }
        for (const item of candidate) visit(item, depth + 1)
        return
      }

      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JSON objects must use a plain object prototype')
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new TypeError('JSON objects must not contain symbol keys')
      }

      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const keys = Object.keys(descriptors)
      if (keys.length > limits.maxObjectKeys) {
        throw new RangeError(
          `JSON object exceeds maximum key count ${limits.maxObjectKeys}`,
        )
      }

      for (const key of keys) {
        if (key.length > limits.maxStringLength) {
          throw new RangeError(
            `JSON key exceeds maximum length ${limits.maxStringLength}`,
          )
        }
        const descriptor = descriptors[key]!
        if (!('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError(
            'JSON objects must contain only enumerable data properties',
          )
        }
        visit(descriptor.value, depth + 1)
      }
    } finally {
      active.delete(candidate)
    }
  }

  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Value is not JSON-compatible')
  }
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes) {
    throw new RangeError(`JSON value exceeds maximum size ${limits.maxBytes}`)
  }
}
