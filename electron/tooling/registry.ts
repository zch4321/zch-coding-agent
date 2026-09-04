import type { Static, TSchema } from '@sinclair/typebox'
import type { ValidateFunction } from 'ajv'
import { MAX_TOOL_INTENT_LENGTH } from '../../shared/durable'
import type { JsonValue } from '../../shared/json'
import type { ProviderToolDefinition } from '../providers/provider'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  ToolCall,
  ToolDefinition,
  ToolRegistrationPort,
} from './contracts'
import { normalizeToolInput } from './input-normalizer'

interface RegisteredTool {
  readonly definition: ToolDefinition
  readonly validate: ValidateFunction
  readonly providerDefinition: ProviderToolDefinition
}

const INTENT_FIELD_BASE = '_agent_intent'

function providerParameters(definition: ToolDefinition): {
  parameters: JsonValue
  intentField: string
} {
  const schema = structuredClone(definition.inputSchema) as Record<
    string,
    unknown
  >
  const properties =
    schema.properties &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {}
  let intentField = INTENT_FIELD_BASE
  let suffix = 2

  while (Object.hasOwn(properties, intentField)) {
    intentField = `${INTENT_FIELD_BASE}_${suffix}`
    suffix += 1
  }

  properties[intentField] = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_TOOL_INTENT_LENGTH,
    description:
      'Briefly state why this tool call is needed. This metadata is removed before tool execution.',
  }
  schema.properties = properties
  schema.required = [
    ...(Array.isArray(schema.required) ? schema.required : []),
    intentField,
  ]

  return { parameters: schema as JsonValue, intentField }
}

function withoutIntentMetadata(
  args: JsonValue,
  intentField: string,
): { args: JsonValue; reason: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { args, reason: '' }
  }

  const normalized = structuredClone(args)
  const rawReason = normalized[intentField]
  delete normalized[intentField]
  return {
    args: normalized,
    reason:
      typeof rawReason === 'string'
        ? rawReason.slice(0, MAX_TOOL_INTENT_LENGTH)
        : '',
  }
}

/** Registers Tool definitions and owns their compiled provider/input contracts. */
export class ToolRegistry implements ToolRegistrationPort {
  readonly #tools = new Map<string, RegisteredTool>()

  /** Adds a unique Tool definition to the registry. */
  registerTool(definition: ToolDefinition): void {
    if (this.#tools.has(definition.id)) {
      throw new Error(`Tool already registered: ${definition.id}`)
    }

    const { parameters, intentField } = providerParameters(definition)
    this.#tools.set(definition.id, {
      definition,
      validate: compileSchema(definition.inputSchema),
      providerDefinition: {
        name: definition.id,
        description: definition.description,
        inputSchema: parameters,
        intentParameter: intentField,
      },
    })
  }

  /** Returns a registered Tool definition by ID. */
  get(toolId: string): ToolDefinition | undefined {
    return this.#tools.get(toolId)?.definition
  }

  /** Returns all registered Tool definitions in registration order. */
  list(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition)
  }

  /** Converts registered Tools into neutral schemas with intent metadata. */
  providerDefinitions(): ProviderToolDefinition[] {
    return [...this.#tools.values()].map((tool) =>
      structuredClone(tool.providerDefinition),
    )
  }

  /** Removes the registered provider-only intent field from a canonical call. */
  normalizeCall(call: ToolCall): ToolCall {
    const registered = this.#tools.get(call.toolId)
    if (!registered) return call
    const withoutIntent = withoutIntentMetadata(
      call.args,
      registered.providerDefinition.intentParameter,
    )
    return {
      ...call,
      args: normalizeToolInput(
        registered.definition.inputSchema,
        withoutIntent.args,
      ),
      reason: call.reason || withoutIntent.reason,
    }
  }

  /** Validates model-produced arguments and returns their schema-typed form. */
  validateArgs<Schema extends TSchema>(
    definition: ToolDefinition<Schema>,
    args: JsonValue,
  ): { ok: true; args: Static<Schema> } | { ok: false; message: string } {
    const registered = this.#tools.get(definition.id)

    if (!registered) {
      return { ok: false, message: `Unknown tool: ${definition.id}` }
    }

    const withoutIntent = withoutIntentMetadata(
      args,
      registered.providerDefinition.intentParameter,
    ).args
    const normalized = normalizeToolInput(definition.inputSchema, withoutIntent)

    if (!registered.validate(normalized)) {
      return {
        ok: false,
        message: formatSchemaErrors(registered.validate.errors),
      }
    }

    const typedArgs = normalized as Static<Schema>
    const validationMessage = definition.validateArgs?.(typedArgs)

    if (validationMessage) {
      return { ok: false, message: validationMessage }
    }

    return { ok: true, args: typedArgs }
  }

  /** Strictly validates already-normalized arguments at the execution boundary. */
  validateCanonicalArgs<Schema extends TSchema>(
    definition: ToolDefinition<Schema>,
    args: JsonValue,
  ): { ok: true; args: Static<Schema> } | { ok: false; message: string } {
    const registered = this.#tools.get(definition.id)
    if (!registered) {
      return { ok: false, message: `Unknown tool: ${definition.id}` }
    }
    const canonical = withoutIntentMetadata(
      args,
      registered.providerDefinition.intentParameter,
    ).args
    if (!registered.validate(canonical)) {
      return {
        ok: false,
        message: formatSchemaErrors(registered.validate.errors),
      }
    }
    const typedArgs = canonical as Static<Schema>
    const validationMessage = definition.validateArgs?.(typedArgs)
    return validationMessage
      ? { ok: false, message: validationMessage }
      : { ok: true, args: typedArgs }
  }
}
