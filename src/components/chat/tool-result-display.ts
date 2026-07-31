type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function messagePartValue(part: unknown): unknown {
  if (!isRecord(part)) return part
  if (part.type === 'text' && typeof part.text === 'string') return part.text
  if (part.type === 'json' && 'value' in part) return part.value
  return part
}

function durableResultValue(result: unknown): unknown {
  if (
    !isRecord(result) ||
    result.type !== 'tool_result' ||
    !Array.isArray(result.content)
  ) {
    return result
  }

  const values = result.content.map(messagePartValue)
  if (values.length === 1) return values[0]
  if (values.every((value) => typeof value === 'string')) {
    return values.join('\n')
  }
  return values
}

/** Extracts the user-facing content from live and durable tool-result envelopes. */
export function toolResultDisplayContent(result: unknown): unknown {
  const value = durableResultValue(result)
  if (!isRecord(value) || typeof value.status !== 'string') return value

  if (value.status === 'ok' && 'content' in value) {
    return value.content
  }
  return typeof value.message === 'string' ? value.message : value
}

/** Formats tool content without adding JSON quotes around plain text. */
export function formatToolResultDisplay(value: unknown): string {
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
