import type { Static, TSchema } from '@sinclair/typebox'
import type { ValidateFunction } from 'ajv'
import type { JsonValue } from '../../shared/json'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistrationPort,
  ToolResult,
} from '../tools/types'
import {
  revalidateApprovedToolCall,
  type ApprovedToolCall,
} from './permission-pipeline'

interface RegisteredTool {
  readonly definition: ToolDefinition
  readonly validate: ValidateFunction
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
    maxLength: 2_048,
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

export class ToolRegistry implements ToolRegistrationPort {
  readonly #tools = new Map<string, RegisteredTool>()

  registerTool(definition: ToolDefinition): void {
    if (this.#tools.has(definition.id)) {
      throw new Error(`Tool already registered: ${definition.id}`)
    }

    this.#tools.set(definition.id, {
      definition,
      validate: compileSchema(definition.inputSchema),
    })
  }

  get(toolId: string): ToolDefinition | undefined {
    return this.#tools.get(toolId)?.definition
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition)
  }

  providerDefinitions(): JsonValue[] {
    return this.list().map((definition) => {
      const { parameters, intentField } = providerParameters(definition)
      return {
        type: 'function',
        function: {
          name: definition.id,
          description: definition.description,
          parameters,
          'x-agent-intent-property': intentField,
        },
      }
    })
  }

  validateArgs<Schema extends TSchema>(
    definition: ToolDefinition<Schema>,
    args: JsonValue,
  ): { ok: true; args: Static<Schema> } | { ok: false; message: string } {
    const registered = this.#tools.get(definition.id)

    if (!registered) {
      return { ok: false, message: `Unknown tool: ${definition.id}` }
    }

    if (!registered.validate(args)) {
      return {
        ok: false,
        message: formatSchemaErrors(registered.validate.errors),
      }
    }

    const typedArgs = args as Static<Schema>
    const validationMessage = definition.validateArgs?.(typedArgs)

    if (validationMessage) {
      return { ok: false, message: validationMessage }
    }

    return { ok: true, args: typedArgs }
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

export class ToolExecutor {
  readonly #registry: ToolRegistry

  constructor(registry: ToolRegistry) {
    this.#registry = registry
  }

  inspectCall(
    call: ToolCall,
  ):
    | { ok: true; definition: ToolDefinition }
    | { ok: false; result: ToolResult } {
    const definition = this.#registry.get(call.toolId)

    if (!definition) {
      return {
        ok: false,
        result: {
          status: 'error',
          code: 'UNKNOWN_TOOL',
          message: `Unknown tool: ${call.toolId}`,
          retryable: false,
        },
      }
    }

    const validation = this.#registry.validateArgs(definition, call.args)

    if (!validation.ok) {
      return {
        ok: false,
        result: {
          status: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: validation.message,
          retryable: false,
        },
      }
    }

    return { ok: true, definition }
  }

  async execute(
    approvedCall: ApprovedToolCall,
    context: Omit<ToolExecutionContext, 'approvedCall' | 'signal'>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const definition = this.#registry.get(approvedCall.toolId)

    if (!definition) {
      return {
        status: 'error',
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${approvedCall.toolId}`,
        retryable: false,
      }
    }

    const validation = this.#registry.validateArgs(
      definition,
      approvedCall.args,
    )

    if (!validation.ok) {
      return {
        status: 'error',
        code: 'INVALID_TOOL_ARGS',
        message: validation.message,
        retryable: false,
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
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('Tool timed out')),
      definition.defaultTimeoutMs,
    )
    const relayAbort = () => timeoutController.abort(signal.reason)

    if (signal.aborted) {
      clearTimeout(timeout)
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
      clearTimeout(timeout)
      signal.removeEventListener('abort', relayAbort)
    }
  }
}
