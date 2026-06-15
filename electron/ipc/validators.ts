import type { JsonValue } from '../../shared/json'

export interface PayloadLimits {
  maxDepth: number
  maxSerializedBytes: number
  maxStringLength: number
  maxArrayLength: number
  maxObjectKeys: number
}

export const DEFAULT_PAYLOAD_LIMITS: PayloadLimits = {
  maxDepth: 24,
  maxSerializedBytes: 2_000_000,
  maxStringLength: 1_000_000,
  maxArrayLength: 10_000,
  maxObjectKeys: 10_000,
}

export type PayloadLimitResult =
  | { valid: true }
  | {
      valid: false
      code: 'PAYLOAD_TOO_LARGE' | 'INVALID_PAYLOAD'
      message: string
    }

export function validatePayloadLimits(
  payload: unknown,
  limits: PayloadLimits = DEFAULT_PAYLOAD_LIMITS,
): PayloadLimitResult {
  let serialized: string | undefined

  try {
    serialized = JSON.stringify(payload)
  } catch {
    return {
      valid: false,
      code: 'INVALID_PAYLOAD',
      message: 'Payload must be JSON serializable',
    }
  }

  if (serialized === undefined) {
    return {
      valid: false,
      code: 'INVALID_PAYLOAD',
      message: 'Payload must be a JSON value',
    }
  }

  if (Buffer.byteLength(serialized, 'utf8') > limits.maxSerializedBytes) {
    return {
      valid: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Serialized payload exceeds the configured size limit',
    }
  }

  const stack: Array<{ value: unknown; depth: number }> = [
    { value: payload, depth: 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()

    if (!current) {
      break
    }

    if (current.depth > limits.maxDepth) {
      return {
        valid: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload nesting exceeds the configured depth limit',
      }
    }

    if (typeof current.value === 'string') {
      if (current.value.length > limits.maxStringLength) {
        return {
          valid: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Payload string exceeds the configured length limit',
        }
      }
      continue
    }

    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        return {
          valid: false,
          code: 'INVALID_PAYLOAD',
          message: 'Payload numbers must be finite',
        }
      }
      continue
    }

    if (current.value === null || typeof current.value === 'boolean') {
      continue
    }

    if (Array.isArray(current.value)) {
      if (current.value.length > limits.maxArrayLength) {
        return {
          valid: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Payload array exceeds the configured item limit',
        }
      }

      for (const value of current.value) {
        stack.push({ value, depth: current.depth + 1 })
      }
      continue
    }

    if (current.value && typeof current.value === 'object') {
      const prototype = Object.getPrototypeOf(current.value)

      if (prototype !== Object.prototype && prototype !== null) {
        return {
          valid: false,
          code: 'INVALID_PAYLOAD',
          message: 'Payload objects must be plain JSON objects',
        }
      }

      const entries = Object.entries(current.value)

      if (entries.length > limits.maxObjectKeys) {
        return {
          valid: false,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Payload object exceeds the configured key limit',
        }
      }

      for (const [, value] of entries) {
        stack.push({ value, depth: current.depth + 1 })
      }
      continue
    }

    return {
      valid: false,
      code: 'INVALID_PAYLOAD',
      message: 'Payload contains a value that is not valid JSON',
    }
  }

  return { valid: true }
}

export function toJsonDetails(value: unknown): JsonValue | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return undefined
  }
}
