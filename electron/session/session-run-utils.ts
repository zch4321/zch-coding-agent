import { getActiveProviderConfig, type PublicConfig } from '../../shared/config'
import type { RunStatus, ToolResultEnvelope } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type { ToolResult } from '../tools/types'
import { ContextBudgetError, estimateJsonTokens } from '../tools/context-budget'
import { resolveModelProfiles } from '../providers/model-catalog'

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function toolResultForProvider(result: ToolResult): string {
  return JSON.stringify(result)
}

export function normalizeToolResult(result: ToolResult): ToolResultEnvelope {
  return result as ToolResultEnvelope
}

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

export function modelPromptBudget(
  config: PublicConfig,
  tools: JsonValue[],
): number {
  const provider = getActiveProviderConfig(config)
  const model = resolveModelProfiles(config, provider.id).find(
    (candidate) => candidate.id === provider.model,
  )
  const contextWindow =
    model?.contextWindowTokens ?? config.limits.maxContextTokens
  const outputReserve = model?.maxOutputTokens
    ? Math.min(model.maxOutputTokens, Math.floor(contextWindow * 0.4))
    : Math.min(8_192, Math.floor(contextWindow * 0.2))
  const toolSchemaTokens = estimateJsonTokens(
    tools,
    config.limits.tokenEstimation,
  )
  const budget = contextWindow - outputReserve - toolSchemaTokens

  if (budget < 1_024) {
    throw new ContextBudgetError(
      'Model output reserve and tool schemas leave no usable prompt budget',
    )
  }

  return budget
}
