import type { JsonObject, JsonValue } from '../../shared/json'

type SchemaNode = Record<string, unknown>

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u
const MAX_SCHEMA_DEPTH = 64

function schemaNode(value: unknown): SchemaNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as SchemaNode)
    : undefined
}

function jsonType(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pointerValue(
  root: SchemaNode,
  reference: string,
): SchemaNode | undefined {
  if (!reference.startsWith('#/')) return undefined
  let current: unknown = root
  for (const token of reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    const object = schemaNode(current)
    if (!object || !Object.hasOwn(object, token)) return undefined
    current = object[token]
  }
  return schemaNode(current)
}

function resolvedSchema(schema: SchemaNode, root: SchemaNode): SchemaNode {
  const reference = typeof schema.$ref === 'string' ? schema.$ref : undefined
  return (reference && pointerValue(root, reference)) || schema
}

function schemaTypes(schema: SchemaNode): string[] {
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type)) {
    return schema.type.filter(
      (entry): entry is string => typeof entry === 'string',
    )
  }
  if (schema.properties || schema.patternProperties) return ['object']
  if (schema.items || schema.prefixItems) return ['array']
  return []
}

function matchesShallow(schema: SchemaNode, value: JsonValue): boolean {
  if (Object.hasOwn(schema, 'const') && !jsonEqual(schema.const, value)) {
    return false
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEqual(candidate, value))
  ) {
    return false
  }
  const types = schemaTypes(schema)
  return types.length === 0 || types.includes(jsonType(value))
}

function matchingVariant(
  variants: unknown[],
  value: JsonValue,
  root: SchemaNode,
  depth: number,
): { schema: SchemaNode; value: JsonValue } | undefined {
  const exact = variants
    .map((variant) => schemaNode(variant))
    .filter((variant): variant is SchemaNode => Boolean(variant))
    .map((variant) => resolvedSchema(variant, root))
    .filter((variant) => matchesShallow(variant, value))
  if (exact.length === 1) return { schema: exact[0]!, value }

  const converted = variants
    .map((variant) => schemaNode(variant))
    .filter((variant): variant is SchemaNode => Boolean(variant))
    .map((variant) => resolvedSchema(variant, root))
    .map((variant) => ({
      schema: variant,
      value: normalizeNode(variant, value, root, depth + 1),
    }))
    .filter((candidate) => matchesShallow(candidate.schema, candidate.value))
  return converted.length === 1 ? converted[0] : undefined
}

function coerceScalar(value: JsonValue, types: string[]): JsonValue {
  if (value === null || typeof value === 'object') return value
  if (types.includes(typeof value)) return value

  for (const type of types) {
    if (
      type === 'string' &&
      (typeof value === 'number' || typeof value === 'boolean')
    ) {
      return String(value)
    }
    if (
      (type === 'number' || type === 'integer') &&
      typeof value === 'string'
    ) {
      const trimmed = value.trim()
      if (!JSON_NUMBER.test(trimmed)) continue
      const number = Number(trimmed)
      if (
        !Number.isFinite(number) ||
        (type === 'integer' && !Number.isInteger(number))
      ) {
        continue
      }
      return number
    }
    if (type === 'boolean' && typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
    }
  }
  return value
}

function matchingPatternSchema(
  patterns: SchemaNode | undefined,
  key: string,
): SchemaNode | undefined {
  if (!patterns) return undefined
  for (const [pattern, candidate] of Object.entries(patterns)) {
    try {
      if (new RegExp(pattern, 'u').test(key)) return schemaNode(candidate)
    } catch {
      return undefined
    }
  }
  return undefined
}

function normalizeObject(
  schema: SchemaNode,
  value: JsonObject,
  root: SchemaNode,
  depth: number,
): JsonObject {
  const properties = schemaNode(schema.properties) ?? {}
  const patterns = schemaNode(schema.patternProperties)
  const additional = schema.additionalProperties
  const normalized: JsonObject = {}

  for (const [key, entry] of Object.entries(value)) {
    const propertySchema =
      schemaNode(properties[key]) ?? matchingPatternSchema(patterns, key)
    if (propertySchema) {
      normalized[key] = normalizeNode(propertySchema, entry, root, depth + 1)
    } else if (additional === false) {
      continue
    } else if (schemaNode(additional)) {
      normalized[key] = normalizeNode(
        additional as SchemaNode,
        entry,
        root,
        depth + 1,
      )
    } else {
      normalized[key] = entry
    }
  }
  return normalized
}

function normalizeArray(
  schema: SchemaNode,
  value: JsonValue[],
  root: SchemaNode,
  depth: number,
): JsonValue[] {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : []
  const itemSchema = schemaNode(schema.items)
  return value.map((entry, index) => {
    const schemaForEntry = schemaNode(prefixItems[index]) ?? itemSchema
    return schemaForEntry
      ? normalizeNode(schemaForEntry, entry, root, depth + 1)
      : entry
  })
}

function normalizeNode(
  unresolved: SchemaNode,
  value: JsonValue,
  root: SchemaNode,
  depth: number,
): JsonValue {
  if (depth > MAX_SCHEMA_DEPTH) return value
  const schema = resolvedSchema(unresolved, root)
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (variants) {
    const matched = matchingVariant(variants, value, root, depth)
    if (matched)
      return normalizeNode(matched.schema, matched.value, root, depth + 1)
  }

  const coerced = coerceScalar(value, schemaTypes(schema))
  if (Array.isArray(coerced)) {
    return normalizeArray(schema, coerced, root, depth)
  }
  if (coerced !== null && typeof coerced === 'object') {
    return normalizeObject(schema, coerced, root, depth)
  }
  return coerced
}

/**
 * Repairs common model-generated tool argument mistakes without guessing
 * object/array shapes or changing nulls into executable scalar values.
 */
export function normalizeToolInput(
  schema: unknown,
  value: JsonValue,
): JsonValue {
  const root = schemaNode(schema)
  if (!root) return structuredClone(value)
  return normalizeNode(root, structuredClone(value), root, 0)
}
