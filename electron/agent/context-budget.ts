import type { PublicConfig } from '../../shared/config'
import type { ToolResult } from '../tools/types'
import type { ProviderMessage } from './provider'

const TRUNCATION_MARKER = '\n... output truncated ...\n'

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextBudgetError'
  }
}

export function estimateTextTokens(
  value: string,
  estimation: PublicConfig['limits']['tokenEstimation'],
): number {
  const bytes = Buffer.byteLength(value, 'utf8')
  const bytesPerToken =
    estimation.mode === 'custom-bytes' ? estimation.bytesPerToken : 3
  return Math.ceil(bytes / bytesPerToken)
}

export function estimateJsonTokens(
  value: unknown,
  estimation: PublicConfig['limits']['tokenEstimation'],
): number {
  return estimateTextTokens(JSON.stringify(value), estimation)
}

function decodeUtf8Slice(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(value)
}

export function truncateTextHeadTail(
  value: string,
  maxTokens: number,
  estimation: PublicConfig['limits']['tokenEstimation'],
): string {
  if (estimateTextTokens(value, estimation) <= maxTokens) {
    return value
  }

  const bytesPerToken =
    estimation.mode === 'custom-bytes' ? estimation.bytesPerToken : 3
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const maxBytes = Math.max(markerBytes, Math.floor(maxTokens * bytesPerToken))
  const source = Buffer.from(value)
  const retainedBytes = Math.max(0, maxBytes - markerBytes)
  const headBytes = Math.floor(retainedBytes * 0.4)
  const tailBytes = retainedBytes - headBytes

  return `${decodeUtf8Slice(source.subarray(0, headBytes))}${TRUNCATION_MARKER}${decodeUtf8Slice(source.subarray(Math.max(headBytes, source.length - tailBytes)))}`
}

export function boundToolResultForContext(
  result: ToolResult,
  limits: PublicConfig['limits'],
  usedTokens: number,
): { result: ToolResult; tokens: number } {
  const remaining = Math.max(0, limits.maxToolTokensPerRun - usedTokens)
  const allowed = Math.min(limits.maxToolResultTokens, remaining)

  if (allowed <= 0) {
    const bounded: ToolResult = {
      status: 'ok',
      content: {
        truncated: true,
        message:
          'Tool result omitted because the run tool-context budget is exhausted',
      },
      truncated: true,
      totalBytes:
        result.status === 'ok'
          ? (result.totalBytes ?? Buffer.byteLength(JSON.stringify(result)))
          : Buffer.byteLength(JSON.stringify(result)),
    }
    return {
      result: bounded,
      tokens: estimateJsonTokens(bounded, limits.tokenEstimation),
    }
  }

  const tokens = estimateJsonTokens(result, limits.tokenEstimation)

  if (tokens <= allowed) {
    return { result, tokens }
  }

  const serialized = JSON.stringify(result)
  const bounded: ToolResult = {
    status: 'ok',
    content: {
      truncated: true,
      preview: truncateTextHeadTail(
        serialized,
        Math.max(1, allowed - 64),
        limits.tokenEstimation,
      ),
      message: 'Tool result exceeded the model-context budget',
    },
    truncated: true,
    totalBytes:
      result.status === 'ok'
        ? (result.totalBytes ?? Buffer.byteLength(serialized))
        : Buffer.byteLength(serialized),
  }

  return {
    result: bounded,
    tokens: estimateJsonTokens(bounded, limits.tokenEstimation),
  }
}

function historyGroups(history: ProviderMessage[]): ProviderMessage[][] {
  const groups: ProviderMessage[][] = []

  for (const message of history) {
    if (message.role === 'user' || groups.length === 0) {
      groups.push([message])
    } else {
      groups.at(-1)!.push(message)
    }
  }

  return groups
}

export function selectContextMessages(options: {
  system: ProviderMessage
  history: ProviderMessage[]
  maxPromptTokens: number
  estimation: PublicConfig['limits']['tokenEstimation']
}): ProviderMessage[] {
  const groups = historyGroups(options.history)
  let messages = [options.system, ...groups.flat()]

  while (
    groups.length > 1 &&
    estimateJsonTokens(messages, options.estimation) > options.maxPromptTokens
  ) {
    groups.shift()
    messages = [options.system, ...groups.flat()]
  }

  if (
    estimateJsonTokens(messages, options.estimation) > options.maxPromptTokens
  ) {
    throw new ContextBudgetError(
      'The latest complete conversation turn exceeds the model context budget',
    )
  }

  return messages
}
