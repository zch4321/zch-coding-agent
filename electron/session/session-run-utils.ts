import type { RunStatus, ToolResultEnvelope } from '../../shared/agent-events'
import type { ToolResult } from '../tools/types'
import { ContextBudgetError } from '../tools/context-budget'
import type { ModelProfile } from '../providers/model-catalog'

/** Resolves after the requested number of milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serializes a tool result into the provider-facing result text. */
export function toolResultForProvider(result: ToolResult): string {
  return JSON.stringify(result)
}

/** Converts an internal ToolResult into the provider result envelope. */
export function normalizeToolResult(result: ToolResult): ToolResultEnvelope {
  return result as ToolResultEnvelope
}

/** Maps an unknown tool failure or abort signal into a safe ToolResult. */
export function toolFailure(error: unknown, signal: AbortSignal): ToolResult {
  if (signal.aborted) {
    return { status: 'cancelled', message: 'The run was cancelled' }
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
}

/** Maps an exception or abort signal to the terminal RunStatus value. */
export function finalStatusFromError(
  error: unknown,
  signal: AbortSignal,
): RunStatus {
  if (signal.aborted) {
    return 'cancelled'
  }

  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'AbortError'
  ) {
    return 'cancelled'
  }

  return 'failed'
}

/** Resolves the bounded output allowance used by compilation and prompt budgeting. */
export function modelOutputTokenLimit(
  model: Pick<ModelProfile, 'contextWindowTokens' | 'maxOutputTokens'>,
): number {
  const contextWindow = model.contextWindowTokens
  return model.maxOutputTokens
    ? Math.min(model.maxOutputTokens, Math.floor(contextWindow * 0.4))
    : Math.min(8_192, Math.floor(contextWindow * 0.2))
}

/** Computes the usable prompt budget after reserving the model's output allowance. */
export function modelPromptBudget(
  model: Pick<ModelProfile, 'contextWindowTokens' | 'maxOutputTokens'>,
): number {
  const contextWindow = model.contextWindowTokens
  const outputReserve = modelOutputTokenLimit(model)
  const budget = contextWindow - outputReserve

  if (budget < 1_024) {
    throw new ContextBudgetError(
      'Model output reserve leaves no usable prompt budget',
    )
  }

  return budget
}
