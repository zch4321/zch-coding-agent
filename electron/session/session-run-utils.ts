import type { RunStatus, ToolResultEnvelope } from '../../shared/agent-events'
import type { ToolResult } from '../tools/types'
import { ContextBudgetError } from '../tools/context-budget'
import type { ModelProfile } from '../providers/model-catalog'

/** Returns or updates delay state. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Returns or updates tool result for provider state. */
export function toolResultForProvider(result: ToolResult): string {
  return JSON.stringify(result)
}

/** Normalizes tool result. */
export function normalizeToolResult(result: ToolResult): ToolResultEnvelope {
  return result as ToolResultEnvelope
}

/** Returns or updates tool failure state. */
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

/** Returns or updates final status from error state. */
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

/** Returns or updates model prompt budget state. */
export function modelPromptBudget(
  model: Pick<ModelProfile, 'contextWindowTokens' | 'maxOutputTokens'>,
): number {
  const contextWindow = model.contextWindowTokens
  const outputReserve = model?.maxOutputTokens
    ? Math.min(model.maxOutputTokens, Math.floor(contextWindow * 0.4))
    : Math.min(8_192, Math.floor(contextWindow * 0.2))
  const budget = contextWindow - outputReserve

  if (budget < 1_024) {
    throw new ContextBudgetError(
      'Model output reserve leaves no usable prompt budget',
    )
  }

  return budget
}
