import type { PublicConfig } from '../../shared/config'
import { renderToolResultContent } from '../../shared/message'
import type { ToolResultProjection } from './types'

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
  let start = 0
  while (
    start < value.length &&
    (value[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1
  }
  for (
    let end = value.length;
    end >= Math.max(start, value.length - 3);
    end -= 1
  ) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        value.subarray(start, end),
      )
    } catch {
      // A UTF-8 code point can span at most four bytes.
    }
  }
  return ''
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

/** Fits projected Tool Result content to the remaining model-context budget. */
export function boundToolResultProjectionForContext(
  projection: ToolResultProjection,
  limits: PublicConfig['limits'],
  usedTokens: number,
): { projection: ToolResultProjection; tokens: number } {
  const remaining = Math.max(0, limits.maxToolTokensPerRun - usedTokens)
  const allowed = Math.min(limits.maxToolResultTokens, remaining)
  const rendered = renderToolResultContent(projection.content)
  const tokens = estimateTextTokens(rendered, limits.tokenEstimation)

  if (tokens <= allowed) {
    return { projection, tokens }
  }

  const previewBudget =
    allowed <= 0
      ? Math.min(
          limits.maxToolResultTokens,
          EXHAUSTED_TOOL_RESULT_PREVIEW_TOKENS,
        )
      : allowed
  const bounded: ToolResultProjection = {
    content: [
      {
        type: 'text',
        text: truncateTextHeadTail(
          rendered,
          Math.max(1, previewBudget),
          limits.tokenEstimation,
        ),
      },
    ],
    isError: projection.isError,
    truncated: true,
  }

  return {
    projection: bounded,
    tokens: estimateTextTokens(
      renderToolResultContent(bounded.content),
      limits.tokenEstimation,
    ),
  }
}
