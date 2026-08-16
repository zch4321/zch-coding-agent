import type { Static, TSchema } from '@sinclair/typebox'
import type { ValidateFunction } from 'ajv'
import type { JsonValue } from '../../shared/json'
import { MAX_TOOL_INTENT_LENGTH } from '../../shared/durable'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistrationPort,
  ToolResult,
  ToolResultProjection,
} from './types'
import type { ApprovedToolCall } from './approved-tool-call'
import { revalidateApprovedToolCall } from '../permission/permission-pipeline'
import type { ProviderToolDefinition } from '../providers/provider'
import { normalizeToolInput } from './tool-input-normalizer'
import { projectToolResultForModel } from './tool-result-projection'

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

/** Registers tool definitions and validates provider and executor access to them. */
export class ToolRegistry implements ToolRegistrationPort {
  readonly #tools = new Map<string, RegisteredTool>()

  /** Adds a unique tool definition to the registry. */
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

  /** Returns a registered tool definition by ID. */
  get(toolId: string): ToolDefinition | undefined {
    return this.#tools.get(toolId)?.definition
  }

  /** Returns all registered tool definitions in registration order. */
  list(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition)
  }

  /** Converts registered tools into neutral schemas with intent metadata. */
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

  /** Validates JSON arguments against a tool schema and returns typed arguments or an error. */
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

function timeoutResult(toolId: string): ToolResult {
  return {
    status: 'timeout',
    message: `${toolId} timed out`,
  }
}

function cancelledResult(): ToolResult {
  return {
    status: 'cancelled',
    message: 'The run was cancelled',
  }
}

function boundResult(result: ToolResult, maxBytes: number): ToolResult {
  if (result.status !== 'ok') {
    return result
  }

  const serialized = JSON.stringify(result.content)
  const totalBytes = Buffer.byteLength(serialized, 'utf8')

  if (totalBytes <= maxBytes) {
    return {
      ...result,
      totalBytes: result.totalBytes ?? totalBytes,
    }
  }

  const bytes = Buffer.from(serialized, 'utf8')
  let lower = 0
  let upper = bytes.length
  let bounded: ToolResult = {
    status: 'ok',
    content: {
      truncated: true,
      preview: '',
      message: 'Tool output exceeded the configured limit',
    },
    truncated: true,
    totalBytes,
  }

  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2)
    const preview = new TextDecoder().decode(bytes.subarray(0, retained))
    const candidate: ToolResult = {
      status: 'ok',
      content: {
        truncated: true,
        preview,
        message: 'Tool output exceeded the configured limit',
      },
      truncated: true,
      totalBytes,
    }

    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      bounded = candidate
      lower = retained + 1
    } else {
      upper = retained - 1
    }
  }

  return bounded
}

/** Validates approved calls and executes definitions with abort and settlement tracking. */
export class ToolExecutor {
  readonly #registry: ToolRegistry

  constructor(registry: ToolRegistry) {
    this.#registry = registry
  }

  /** Removes provider-only metadata before validation, policy, and execution. */
  normalizeCall(call: ToolCall): ToolCall {
    return this.#registry.normalizeCall(call)
  }

  /** Projects one safe Tool Result through its registered or dynamic definition. */
  projectResultForModel(
    call: ToolCall,
    result: ToolResult,
    definitionOverride?: ToolDefinition,
    onDiagnostic?: (message: string, error: unknown) => void,
  ): ToolResultProjection {
    return projectToolResultForModel({
      call,
      result,
      definition: definitionOverride ?? this.#registry.get(call.toolId),
      onDiagnostic,
    })
  }

  /** Checks that a call references a known definition and matches approved arguments. */
  inspectCall(
    call: ToolCall,
    definitionOverride?: ToolDefinition,
  ):
    | { ok: true; definition: ToolDefinition }
    | { ok: false; result: ToolResult; definition?: ToolDefinition } {
    const definition = definitionOverride ?? this.#registry.get(call.toolId)

    if (!definition) {
      return {
        ok: false,
        result: {
          status: 'error',
          code: 'UNKNOWN_TOOL',
          message: `Unknown tool: ${call.toolId}. Choose a tool exposed for this Run and try again.`,
          retryable: true,
        },
      }
    }

    const validation = definitionOverride
      ? validateUnregisteredDefinition(definition, call.args)
      : this.#registry.validateArgs(definition, call.args)

    if (!validation.ok) {
      return {
        ok: false,
        definition,
        result: {
          status: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: `Invalid arguments for ${call.toolId}: ${validation.message}. Correct the listed fields and call the tool again.`,
          retryable: true,
        },
      }
    }

    return { ok: true, definition }
  }

  /** Executes an approved tool and normalizes abort, policy, and handler failures. */
  async execute(
    approvedCall: ApprovedToolCall,
    context: Omit<ToolExecutionContext, 'approvedCall' | 'signal'>,
    signal: AbortSignal,
    onNonAbortableSettlement?: (settlement: Promise<void>) => void,
    definitionOverride?: ToolDefinition,
  ): Promise<ToolResult> {
    const definition =
      definitionOverride ?? this.#registry.get(approvedCall.toolId)

    if (!definition) {
      return {
        status: 'error',
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${approvedCall.toolId}. Choose a tool exposed for this Run and try again.`,
        retryable: true,
      }
    }

    const validation = definitionOverride
      ? validateUnregisteredDefinition(definition, approvedCall.args, false)
      : this.#registry.validateCanonicalArgs(definition, approvedCall.args)

    if (!validation.ok) {
      return {
        status: 'error',
        code: 'INVALID_TOOL_ARGS',
        message: `Invalid arguments for ${approvedCall.toolId}: ${validation.message}. Correct the listed fields and call the tool again.`,
        retryable: true,
      }
    }

    try {
      await revalidateApprovedToolCall(approvedCall, {
        sessionId: context.sessionId,
        runId: context.runId,
        workspace: context.workspace.canonicalPath,
      })
    } catch (error) {
      return {
        status: 'error',
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'APPROVAL_INVALIDATED',
        message:
          error instanceof Error
            ? error.message
            : 'Approval was invalidated before execution',
        retryable: false,
      }
    }

    const timeoutController = new AbortController()
    const timeout =
      definition.defaultTimeoutMs === null
        ? undefined
        : setTimeout(
            () => timeoutController.abort(new Error('Tool timed out')),
            definition.defaultTimeoutMs,
          )
    const relayAbort = () => timeoutController.abort(signal.reason)

    if (signal.aborted) {
      if (timeout) clearTimeout(timeout)
      return cancelledResult()
    }

    signal.addEventListener('abort', relayAbort, { once: true })

    try {
      const executed = definition.execute(validation.args, {
        ...context,
        signal: timeoutController.signal,
        approvedCall,
      })

      if (definition.supportsAbort) {
        const result = await executed

        if (timeoutController.signal.aborted) {
          return signal.aborted
            ? cancelledResult()
            : timeoutResult(definition.id)
        }

        return boundResult(result, definition.maxOutputBytes)
      }

      const settlement = executed.then(
        () => undefined,
        () => undefined,
      )
      onNonAbortableSettlement?.(settlement)

      const aborted = new Promise<ToolResult>((resolve) => {
        timeoutController.signal.addEventListener(
          'abort',
          () => {
            resolve(
              signal.aborted ? cancelledResult() : timeoutResult(definition.id),
            )
          },
          { once: true },
        )
      })
      const result = await Promise.race([executed, aborted])
      return boundResult(result, definition.maxOutputBytes)
    } catch (error) {
      if (signal.aborted) {
        return cancelledResult()
      }

      if (timeoutController.signal.aborted) {
        return timeoutResult(definition.id)
      }

      return {
        status: 'error',
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'TOOL_FAILED',
        message:
          error instanceof Error ? error.message : 'Tool failed unexpectedly',
        retryable: false,
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', relayAbort)
    }
  }
}

function validateUnregisteredDefinition<Schema extends TSchema>(
  definition: ToolDefinition<Schema>,
  args: JsonValue,
  normalize = true,
): { ok: true; args: Static<Schema> } | { ok: false; message: string } {
  const validate = compileSchema(definition.inputSchema)
  const normalized = normalize
    ? normalizeToolInput(definition.inputSchema, args)
    : structuredClone(args)
  if (!validate(normalized)) {
    return { ok: false, message: formatSchemaErrors(validate.errors) }
  }
  const typedArgs = normalized as Static<Schema>
  const message = definition.validateArgs?.(typedArgs)
  return message ? { ok: false, message } : { ok: true, args: typedArgs }
}
