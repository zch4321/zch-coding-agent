import type { PublicConfig } from '../../shared/config'
import type { ToolResult } from './types'

const TRUNCATION_MARKER = '\n... output truncated ...\n'
const EXHAUSTED_TOOL_RESULT_PREVIEW_TOKENS = 512

/** Reports failures to fit provider context within configured token limits. */
export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextBudgetError'
  }
}

/** Estimates text tokens from UTF-8 byte length and the configured estimation ratio. */
export function estimateTextTokens(
  value: string,
  estimation: PublicConfig['limits']['tokenEstimation'],
): number {
  const bytes = Buffer.byteLength(value, 'utf8')
  const bytesPerToken =
    estimation.mode === 'custom-bytes' ? estimation.bytesPerToken : 3
  return Math.ceil(bytes / bytesPerToken)
}

/** Estimates JSON tokens by serializing the value before applying text estimation. */
export function estimateJsonTokens(
  value: unknown,
  estimation: PublicConfig['limits']['tokenEstimation'],
): number {
  return estimateTextTokens(JSON.stringify(value), estimation)
}

function decodeUtf8Slice(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(value)
}

/** Truncates text around its head and tail so the estimated token count stays bounded. */
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

/** Fits a tool result to the remaining context budget while preserving status and metadata. */
export function boundToolResultForContext(
  result: ToolResult,
  limits: PublicConfig['limits'],
  usedTokens: number,
): { result: ToolResult; tokens: number } {
  const remaining = Math.max(0, limits.maxToolTokensPerRun - usedTokens)
  const allowed = Math.min(limits.maxToolResultTokens, remaining)

  const tokens = estimateJsonTokens(result, limits.tokenEstimation)

  if (tokens <= allowed) {
    return { result, tokens }
  }

  const serialized = JSON.stringify(result)
  const previewBudget =
    allowed <= 0
      ? Math.min(
          limits.maxToolResultTokens,
          EXHAUSTED_TOOL_RESULT_PREVIEW_TOKENS,
        )
      : allowed
  const bounded: ToolResult = {
    status: 'ok',
    content: {
      truncated: true,
      preview: truncateTextHeadTail(
        serialized,
        Math.max(1, previewBudget - 64),
        limits.tokenEstimation,
      ),
      message:
        allowed <= 0
          ? 'Tool result exceeded the run tool-context budget; returning a bounded preview'
          : 'Tool result exceeded the model-context budget',
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
