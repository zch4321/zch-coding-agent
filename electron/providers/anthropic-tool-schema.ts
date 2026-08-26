import type { JsonObject, JsonValue } from '../../shared/json'
import type { ProviderToolDefinition } from './provider'

const UNSUPPORTED_ROOT_KEYWORDS = ['oneOf', 'allOf', 'anyOf'] as const
const SAME_INSTANCE_ARRAY_KEYWORDS = ['oneOf', 'allOf', 'anyOf'] as const
const SAME_INSTANCE_OBJECT_KEYWORDS = ['if', 'then', 'else', 'not'] as const

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function collectSameInstancePropertyNames(
  schema: JsonValue,
  names: Set<string>,
  toolName: string,
): void {
  if (Array.isArray(schema)) {
    for (const branch of schema) {
      collectSameInstancePropertyNames(branch, names, toolName)
    }
    return
  }
  const candidate = jsonObject(schema)
  if (!candidate) return
  if (typeof candidate.$ref === 'string') {
    throw new TypeError(
      `Anthropic tool ${toolName} input schema cannot safely project a top-level combinator containing $ref`,
    )
  }
  if (
    candidate.type !== undefined &&
    candidate.type !== 'object' &&
    !(
      Array.isArray(candidate.type) &&
      candidate.type.some((value) => value === 'object')
    )
  ) {
    throw new TypeError(
      `Anthropic tool ${toolName} input schema cannot safely project a top-level combinator with a non-object branch`,
    )
  }

  const properties = jsonObject(candidate.properties)
  if (properties) {
    for (const name of Object.keys(properties)) names.add(name)
  }
  if (Array.isArray(candidate.required)) {
    for (const name of candidate.required) {
      if (typeof name === 'string') names.add(name)
    }
  }
  for (const keyword of SAME_INSTANCE_ARRAY_KEYWORDS) {
    const branches = candidate[keyword]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      collectSameInstancePropertyNames(branch, names, toolName)
    }
  }
  for (const keyword of SAME_INSTANCE_OBJECT_KEYWORDS) {
    const branch = candidate[keyword]
    if (branch !== undefined) {
      collectSameInstancePropertyNames(branch, names, toolName)
    }
  }
  const dependentSchemas = jsonObject(candidate.dependentSchemas)
  if (dependentSchemas) {
    for (const branch of Object.values(dependentSchemas)) {
      collectSameInstancePropertyNames(branch, names, toolName)
    }
  }
}

/** Projects one Provider-neutral Tool schema into Anthropic's supported root shape. */
export function projectAnthropicToolInputSchema(
  tool: ProviderToolDefinition,
): JsonValue {
  const schema = structuredClone(tool.inputSchema)
  const candidate = jsonObject(schema)
  if (!candidate) return schema
  const unsupportedKeywords = UNSUPPORTED_ROOT_KEYWORDS.filter((keyword) =>
    Object.hasOwn(candidate, keyword),
  )
  if (unsupportedKeywords.length === 0) return schema
  if (candidate.type !== 'object') {
    throw new TypeError(
      `Anthropic tool ${tool.name} input schema must declare type "object" before projecting top-level ${unsupportedKeywords.join(', ')}`,
    )
  }

  const rootProperties = new Set(
    Object.keys(jsonObject(candidate.properties) ?? {}),
  )
  const branchProperties = new Set<string>()
  for (const keyword of unsupportedKeywords) {
    collectSameInstancePropertyNames(
      candidate[keyword] as JsonValue,
      branchProperties,
      tool.name,
    )
  }
  const undeclaredProperties = [...branchProperties].filter(
    (name) => !rootProperties.has(name),
  )
  if (undeclaredProperties.length > 0) {
    throw new TypeError(
      `Anthropic tool ${tool.name} input schema cannot safely remove top-level ${unsupportedKeywords.join(', ')} because the root object does not declare: ${undeclaredProperties.join(', ')}`,
    )
  }

  for (const keyword of unsupportedKeywords) delete candidate[keyword]
  return candidate
}
