import type { ValidateFunction } from 'ajv'
import type { JsonValue } from '../../shared/json'
import {
  renderToolResultContent,
  ToolResultContentSchema,
  type ToolResultContent,
} from '../../shared/message'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolResultProjection,
} from './contracts'

const validateContent: ValidateFunction = compileSchema(ToolResultContentSchema)
const EMPTY_OUTPUT = '[no output]'
const MAX_EVENT_ERROR_LENGTH = 65_536

function isByteBoundedResult(
  result: Extract<ToolResult, { status: 'ok' }>,
): result is Extract<ToolResult, { status: 'ok' }> & {
  content: { truncated: true; preview: string }
} {
  return (
    result.truncated === true &&
    result.content !== null &&
    typeof result.content === 'object' &&
    !Array.isArray(result.content) &&
    result.content.truncated === true &&
    typeof result.content.preview === 'string'
  )
}

function textContent(text: string): ToolResultContent {
  return [{ type: 'text', text: text || EMPTY_OUTPUT }]
}

function jsonCopy(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function defaultSuccessContent(
  result: Extract<ToolResult, { status: 'ok' }>,
): ToolResultContent {
  if (isByteBoundedResult(result)) {
    return textContent(
      `${result.content.preview}\n\n[truncated=true; byteLimitExceeded=true]`,
    )
  }
  return typeof result.content === 'string'
    ? textContent(result.content)
    : [{ type: 'json', value: jsonCopy(result.content) }]
}

function errorText(result: Exclude<ToolResult, { status: 'ok' }>): {
  text: string
  truncated: boolean
} {
  let text: string
  if (result.status === 'error') {
    text = `ERROR ${result.code}: ${result.message}${
      result.retryable ? '\n[retryable=true]' : ''
    }`
  } else {
    text = `${result.status.toUpperCase()}: ${result.message}`
  }
  const characters = Array.from(text)
  if (characters.length <= MAX_EVENT_ERROR_LENGTH) {
    return { text, truncated: false }
  }
  const marker = '\n... output truncated ...\n'
  const retained = MAX_EVENT_ERROR_LENGTH - marker.length
  const head = Math.floor(retained * 0.6)
  return {
    text: `${characters.slice(0, head).join('')}${marker}${characters
      .slice(characters.length - (retained - head))
      .join('')}`,
    truncated: true,
  }
}

function validContent(value: unknown): value is ToolResultContent {
  return validateContent(value)
}

function canonicalContent(content: ToolResultContent): ToolResultContent {
  const normalized = content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'json' as const, value: jsonCopy(part.value) },
  )
  if (!validContent(normalized)) {
    throw new TypeError(
      `Invalid Tool Result projection: ${formatSchemaErrors(
        validateContent.errors,
      )}`,
    )
  }
  return normalized
}

/** Projects one safe internal Tool Result into canonical model-visible parts. */
export function projectToolResultForModel(input: {
  call: ToolCall
  definition?: ToolDefinition
  result: ToolResult
  onDiagnostic?: (message: string, error: unknown) => void
}): ToolResultProjection {
  if (input.result.status !== 'ok') {
    const error = errorText(input.result)
    return {
      content: textContent(error.text),
      isError: true,
      truncated: error.truncated,
      outputPolicy: input.definition?.modelOutputPolicy ?? 'bounded',
    }
  }

  const fallback = canonicalContent(defaultSuccessContent(input.result))
  if (isByteBoundedResult(input.result)) {
    return {
      content: fallback,
      isError: false,
      truncated: true,
      outputPolicy: input.definition?.modelOutputPolicy ?? 'bounded',
    }
  }
  const projector = input.definition?.projectResultForModel
  if (!projector) {
    return {
      content: fallback,
      isError: false,
      truncated: input.result.truncated === true,
      outputPolicy: input.definition?.modelOutputPolicy ?? 'bounded',
    }
  }

  try {
    const projected = projector(
      structuredClone(input.result),
      structuredClone(input.call.args) as never,
    )
    if (!validContent(projected)) {
      throw new TypeError(
        `Invalid Tool Result projection: ${formatSchemaErrors(
          validateContent.errors,
        )}`,
      )
    }
    return {
      content: canonicalContent(projected),
      isError: false,
      truncated: input.result.truncated === true,
      outputPolicy: input.definition?.modelOutputPolicy ?? 'bounded',
    }
  } catch (error) {
    input.onDiagnostic?.(
      `Tool Result projector failed for ${input.call.toolId}`,
      error,
    )
    return {
      content: fallback,
      isError: false,
      truncated: input.result.truncated === true,
      outputPolicy: input.definition?.modelOutputPolicy ?? 'bounded',
    }
  }
}

/** Returns the JsonValue shown for a projected result in live runtime events. */
export function toolResultProjectionValue(
  projection: ToolResultProjection,
): JsonValue {
  const values = projection.content.map((part) =>
    part.type === 'text' ? part.text : structuredClone(part.value),
  )
  if (values.length === 1) return values[0]!
  if (values.every((value) => typeof value === 'string')) {
    return values.join('\n')
  }
  return values
}

/** Returns the UTF-8 model text represented by a Tool Result projection. */
export function toolResultProjectionText(
  projection: ToolResultProjection,
): string {
  return renderToolResultContent(projection.content)
}
