import { createHash } from 'node:crypto'
import type { Static, TSchema } from '@sinclair/typebox'
import type { ValidateFunction } from 'ajv'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistrationPort,
  ToolResult,
} from '../tools/types'

export interface ApprovedToolCall {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly callId: CallId
  readonly toolId: string
  readonly args: JsonValue
  readonly argsHash: string
  readonly approvedBy: 'readonly-fast-path'
  readonly approvedAt: string
}

interface RegisteredTool {
  readonly definition: ToolDefinition
  readonly validate: ValidateFunction
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
    return this.list().map((definition) => ({
      type: 'function',
      function: {
        name: definition.id,
        description: definition.description,
        parameters: definition.inputSchema as JsonValue,
      },
    }))
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

    return { ok: true, args: args as Static<Schema> }
  }
}

export function createArgsHash(args: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

export function approveReadOnlyToolCall(
  sessionId: SessionId,
  runId: RunId,
  call: ToolCall,
  definition: ToolDefinition,
): ApprovedToolCall | undefined {
  const readOnly = definition.effects.every(
    (effect) =>
      effect === 'filesystem.read' ||
      effect === 'terminal.read' ||
      effect === 'instruction.read',
  )

  if (!readOnly || definition.defaultRisk !== 'low') {
    return undefined
  }

  return Object.freeze({
    sessionId,
    runId,
    callId: call.id,
    toolId: call.toolId,
    args: structuredClone(call.args),
    argsHash: createArgsHash(call.args),
    approvedBy: 'readonly-fast-path',
    approvedAt: new Date().toISOString(),
  })
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

  const preview = serialized.slice(0, Math.max(0, maxBytes - 256))

  return {
    status: 'ok',
    content: {
      truncated: true,
      preview,
      message: 'Tool output exceeded the configured limit',
    },
    truncated: true,
    totalBytes,
  }
}

export class ToolExecutor {
  readonly #registry: ToolRegistry

  constructor(registry: ToolRegistry) {
    this.#registry = registry
  }

  prepareReadOnlyCall(
    sessionId: SessionId,
    runId: RunId,
    call: ToolCall,
  ):
    | { ok: true; approvedCall: ApprovedToolCall; definition: ToolDefinition }
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

    const approvedCall = approveReadOnlyToolCall(
      sessionId,
      runId,
      call,
      definition,
    )

    if (!approvedCall) {
      return {
        ok: false,
        result: {
          status: 'denied',
          message: 'Only low-risk read-only tools are available in P2',
        },
      }
    }

    return { ok: true, approvedCall, definition }
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
