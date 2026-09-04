import type { Static, TSchema } from '@sinclair/typebox'
import type { JsonValue } from '../../shared/json'
import { revalidateApprovedToolCall } from '../permission/permission-pipeline'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type { ApprovedToolCall } from './approved-tool-call'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolResultProjection,
} from './contracts'
import { normalizeToolInput } from './input-normalizer'
import {
  createToolCancelled,
  createToolError,
  createToolTimeout,
} from './result-builders'
import { projectToolResultForModel } from './result-projection'
import type { ToolRegistry } from './registry'

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
        result: createToolError(
          'UNKNOWN_TOOL',
          `Unknown tool: ${call.toolId}. Choose a tool exposed for this Run and try again.`,
          true,
        ),
      }
    }

    const validation = definitionOverride
      ? validateUnregisteredDefinition(definition, call.args)
      : this.#registry.validateArgs(definition, call.args)

    if (!validation.ok) {
      return {
        ok: false,
        definition,
        result: createToolError(
          'INVALID_TOOL_ARGS',
          `Invalid arguments for ${call.toolId}: ${validation.message}. Correct the listed fields and call the tool again.`,
          true,
        ),
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
      return createToolError(
        'UNKNOWN_TOOL',
        `Unknown tool: ${approvedCall.toolId}. Choose a tool exposed for this Run and try again.`,
        true,
      )
    }

    const validation = definitionOverride
      ? validateUnregisteredDefinition(definition, approvedCall.args, false)
      : this.#registry.validateCanonicalArgs(definition, approvedCall.args)

    if (!validation.ok) {
      return createToolError(
        'INVALID_TOOL_ARGS',
        `Invalid arguments for ${approvedCall.toolId}: ${validation.message}. Correct the listed fields and call the tool again.`,
        true,
      )
    }

    try {
      await revalidateApprovedToolCall(approvedCall, {
        sessionId: context.sessionId,
        runId: context.runId,
        workspace: context.workspace.canonicalPath,
        sessionTempRoot: context.sessionTemp?.root,
      })
    } catch (error) {
      return createToolError(
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'APPROVAL_INVALIDATED',
        error instanceof Error
          ? error.message
          : 'Approval was invalidated before execution',
      )
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
      return createToolCancelled()
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
            ? createToolCancelled()
            : createToolTimeout(definition.id)
        }

        return result
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
              signal.aborted
                ? createToolCancelled()
                : createToolTimeout(definition.id),
            )
          },
          { once: true },
        )
      })
      return await Promise.race([executed, aborted])
    } catch (error) {
      if (signal.aborted) {
        return createToolCancelled()
      }

      if (timeoutController.signal.aborted) {
        return createToolTimeout(definition.id)
      }

      return createToolError(
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'TOOL_FAILED',
        error instanceof Error ? error.message : 'Tool failed unexpectedly',
      )
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
