import { randomUUID } from 'node:crypto'
import {
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_TOOL_INTENT_LENGTH,
} from '../../shared/durable'
import type { CallId } from '../../shared/ids'
import {
  CANONICAL_JSON_LIMITS,
  type JsonObject,
  type JsonValue,
} from '../../shared/json'
import type { ToolCall } from '../tools/types'
import type { ProviderToolDefinition } from './provider'

/** Converts a JSON-compatible runtime value into a detached JsonValue. */
export function toProviderJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Returns the UTF-8 byte size of a JSON value. */
export function providerJsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Reads a finite non-negative token metric. */
export function providerMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/** Reads one object-valued field from an unknown provider payload. */
export function providerObjectField(
  value: unknown,
  key: string,
): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const field = Reflect.get(value, key)
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as JsonObject)
    : undefined
}

/** Appends provider text while enforcing the canonical message limit. */
export function appendProviderText(
  current: string,
  delta: string,
  label: string,
): string {
  if (current.length + delta.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new RangeError(
      `${label} exceeds maximum length ${MAX_MESSAGE_TEXT_LENGTH}`,
    )
  }
  return current + delta
}

/** Accumulates one call's JSON arguments with UTF-8 work proportional to incoming deltas. */
export class ProviderArgumentsAccumulator {
  #text = ''
  #bytes = 0
  #trailingHighSurrogate = false

  constructor(
    private readonly label: string,
    initial = '',
  ) {
    this.append(initial)
  }

  /** Returns the assembled arguments for final protocol parsing. */
  get text(): string {
    return this.#text
  }

  /** Returns the exact UTF-8 size of the current assembled string. */
  get bytes(): number {
    return this.#bytes
  }

  /** Appends one delta, retaining the prior valid state if the byte bound is exceeded. */
  append(delta: string): void {
    if (!delta) return
    const first = delta.charCodeAt(0)
    const joinsSurrogate =
      this.#trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff
    // Separate surrogate halves each encode as three replacement bytes; together they use four.
    const bytes =
      this.#bytes + Buffer.byteLength(delta, 'utf8') - (joinsSurrogate ? 2 : 0)
    if (bytes > CANONICAL_JSON_LIMITS.maxBytes)
      throw new RangeError(
        `${this.label} exceed maximum size ${CANONICAL_JSON_LIMITS.maxBytes}`,
      )
    const last = delta.charCodeAt(delta.length - 1)
    this.#trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff
    this.#bytes = bytes
    this.#text += delta
  }
}

/** Builds the provider tool-name to internal intent-field lookup. */
export function providerIntentFields(
  tools: readonly ProviderToolDefinition[],
): Map<string, string> {
  return new Map(tools.map((tool) => [tool.name, tool.intentParameter]))
}

/** Parses streamed function arguments, retaining malformed text for diagnostics. */
export function parseProviderArguments(argumentsText: string): JsonValue {
  if (!argumentsText.trim()) return {}
  try {
    return JSON.parse(argumentsText) as JsonValue
  } catch {
    return { _rawArguments: argumentsText }
  }
}

/** Removes the internal intent field and returns one canonical tool call. */
export function normalizeProviderToolCall(input: {
  id: CallId
  name: string
  arguments: JsonValue
  intentFields: ReadonlyMap<string, string>
}): ToolCall {
  const parsed = structuredClone(input.arguments)
  const intentField = input.intentFields.get(input.name)
  if (
    !intentField ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { id: input.id, toolId: input.name, args: parsed, reason: '' }
  }
  const reason =
    typeof parsed[intentField] === 'string'
      ? parsed[intentField].slice(0, MAX_TOOL_INTENT_LENGTH)
      : ''
  delete parsed[intentField]
  return { id: input.id, toolId: input.name, args: parsed, reason }
}

/** Creates a canonical call ID when a provider omits one. */
export function createProviderCallId(): CallId {
  return `call:${randomUUID()}` as CallId
}
