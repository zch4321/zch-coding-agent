import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  ProviderCompactCompletionError,
  ProviderCompletionError,
} from '../providers/provider'
import { LegacyToolResultError } from './canonical-history'
import { CompactionFailedError } from './session-compact-retry'
import { diagnosticCodeForError } from '../operational-logging/diagnostic-id'

export interface ClassifiedRunError {
  code: string
  message: string
}

/** Maps backend exceptions to stable renderer-facing Run error codes. */
export function classifyRunError(error: unknown): ClassifiedRunError {
  const message =
    error instanceof Error ? error.message : 'Run failed unexpectedly'
  if (findCause(error, LegacyToolResultError)) {
    return { code: 'LEGACY_TOOL_RESULT_UNSUPPORTED', message }
  }
  if (findCause(error, CompactionFailedError)) {
    return { code: 'COMPACTION_FAILED', message }
  }
  const diagnosedCode = diagnosticCodeForError(error)
  if (diagnosedCode) return { code: diagnosedCode, message }
  const transport = findCause(error, ProviderTransportError)
  if (transport) {
    const code = {
      ABORTED: 'PROVIDER_ABORTED',
      HTTP_ERROR: 'PROVIDER_HTTP_ERROR',
      NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
      TIMED_OUT: 'PROVIDER_TIMEOUT',
      INVALID_SSE: 'PROVIDER_STREAM_INVALID',
      INVALID_JSON: 'PROVIDER_JSON_INVALID',
    }[transport.code]
    return { code, message }
  }
  if (
    findCause(error, ProviderCompletionError) ||
    findCause(error, ProviderCompactCompletionError)
  ) {
    return { code: 'PROVIDER_COMPLETION_INVALID', message }
  }
  const existingCode = readCode(error)
  if (existingCode === 'TOOL_BATCH_FAILED') {
    return { code: 'TOOL_BATCH_FAILED', message }
  }
  if (
    /provider is not configured|model is not enabled|does not support reasoning effort|credential is not available|model routes? were not resolved/iu.test(
      message,
    )
  ) {
    return { code: 'PROVIDER_CONFIGURATION_ERROR', message }
  }
  if (/stream.+(?:completion|ended)|completion.+invalid/iu.test(message)) {
    return { code: 'PROVIDER_COMPLETION_INVALID', message }
  }
  return { code: 'RUN_FAILED', message }
}

function findCause<T extends Error>(
  error: unknown,
  constructor: abstract new (...args: never[]) => T,
  depth = 0,
): T | undefined {
  if (error instanceof constructor) return error
  if (!error || typeof error !== 'object' || depth >= 3) return undefined
  return findCause(Reflect.get(error, 'cause'), constructor, depth + 1)
}

function readCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
