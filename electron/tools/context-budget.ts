import type { PublicConfig } from '../../shared/config'
import { renderToolResultContent } from '../../shared/message'
import type { ToolResultProjection } from './types'

const TRUNCATION_MARKER = '\n... output truncated ...\n'

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

/** Fits one projected Tool Result to the frozen global byte and line limits. */
export function boundToolResultProjectionForContext(
  projection: ToolResultProjection,
  limits: Pick<
    PublicConfig['limits'],
    'maxToolOutputBytes' | 'maxToolOutputLines'
  >,
): ToolResultProjection {
  if (projection.outputPolicy !== 'bounded') return projection

  const rendered = renderToolResultContent(projection.content)
  const totalBytes = Buffer.byteLength(rendered, 'utf8')
  const lines = rendered.split('\n')
  const totalLines = lines.length
  const byteLimitExceeded = totalBytes > limits.maxToolOutputBytes
  const lineLimitExceeded = totalLines > limits.maxToolOutputLines

  if (!byteLimitExceeded && !lineLimitExceeded) return projection

  const continuation = [
    'artifactPath',
    'resultPath',
    'manifestPath',
    'activityPath',
  ]
    .map((field) => {
      const value =
        new RegExp(`(?:^|[;\\n\\s])${field}=([^;\\]\\n]+)`, 'u')
          .exec(rendered)?.[1]
          ?.trim() ??
        new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'u')
          .exec(rendered)?.[1]
          ?.trim()
      return value ? `${field}=${value}` : undefined
    })
    .find((value) => value !== undefined)
  const marker = `[truncated=true; byteLimitExceeded=${String(
    byteLimitExceeded,
  )}; lineLimitExceeded=${String(
    lineLimitExceeded,
  )}; totalBytes=${totalBytes}; totalLines=${totalLines}${
    continuation ? `; ${continuation}` : ''
  }]`
  const sourceLineLimit = Math.max(0, limits.maxToolOutputLines - 1)
  const sourceHead = lines.slice(0, sourceLineLimit).join('\n')
  const separator = sourceHead
    ? limits.maxToolOutputLines > 1
      ? '\n'
      : ' '
    : ''
  const availableBytes = Math.max(
    0,
    limits.maxToolOutputBytes -
      Buffer.byteLength(`${separator}${marker}`, 'utf8'),
  )
  const boundedHead = decodeUtf8Slice(
    Buffer.from(sourceHead, 'utf8').subarray(0, availableBytes),
  )

  return {
    content: [
      {
        type: 'text',
        text: `${boundedHead}${boundedHead ? separator : ''}${marker}`,
      },
    ],
    isError: projection.isError,
    truncated: true,
    outputPolicy: projection.outputPolicy,
  }
}
