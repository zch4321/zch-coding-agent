import type { ProviderType } from '../../shared/config/providers'
import type { ReasoningEffort } from '../../shared/reasoning'
import type { ProviderUsage } from '../providers/provider'
import type { OperationalLogService } from './service'
import {
  associateDiagnosticId,
  associateDiagnosticCode,
  diagnosticIdForError,
} from './diagnostic-id'
import type { OperationalCorrelation } from './events'

export interface ProviderAttemptInput extends OperationalCorrelation {
  operation: 'main' | 'compact' | 'approval' | 'title' | 'model_catalog'
  providerId: string
  providerType: ProviderType
  model: string
  reasoning?: ReasoningEffort
  endpoint?: string
  messageCount?: number
  toolCount?: number
  requestBytes?: number
}

export interface ProviderAttemptCompletion {
  outcome?: 'completed' | 'cancelled'
  durationMs?: number
  ttftMs?: number | null
  responseBytes?: number
  usage?: ProviderUsage
}

export interface ProviderAttemptFailure extends ProviderAttemptCompletion {
  code: string
  httpStatus?: number
  providerErrorCode?: string
  retryAfterMs?: number
  requestId?: string
}

/** Records one bounded Provider attempt without retaining request content. */
export class ProviderAttemptRecorder {
  readonly #log: Pick<OperationalLogService, 'log'> | undefined
  readonly #input: ProviderAttemptInput
  readonly #startedAt = performance.now()

  constructor(
    log: Pick<OperationalLogService, 'log'> | undefined,
    input: ProviderAttemptInput,
  ) {
    this.#log = log
    this.#input = structuredClone(input)
    this.#log?.log({
      level: 'debug',
      event: 'provider.started',
      ...this.#input,
    })
  }

  /** Records a successful aggregate response. */
  completed(completion: ProviderAttemptCompletion = {}): void {
    this.#log?.log({
      level: 'debug',
      event: 'provider.completed',
      ...this.#input,
      outcome: completion.outcome ?? 'completed',
      durationMs: completion.durationMs ?? performance.now() - this.#startedAt,
      ...(completion.ttftMs === null || completion.ttftMs === undefined
        ? {}
        : { ttftMs: completion.ttftMs }),
      ...(completion.responseBytes === undefined
        ? {}
        : { responseBytes: completion.responseBytes }),
      ...usageFields(completion.usage),
    })
  }

  /** Records a Provider-native fallback as a recoverable warning. */
  fallback(code: string, error?: unknown): void {
    const result = this.#log?.log({
      level: 'warn',
      event: 'provider.fallback',
      ...this.#input,
      code,
      error,
      durationMs: performance.now() - this.#startedAt,
    })
    associateDiagnosticId(error, result?.diagnosticId)
  }

  /** Records a failed attempt and associates its diagnostic ID with the error. */
  failed(error: unknown, failure: ProviderAttemptFailure): void {
    associateDiagnosticCode(error, failure.code)
    const result = this.#log?.log({
      level: 'error',
      event: 'provider.failed',
      ...this.#input,
      diagnosticId: diagnosticIdForError(error),
      code: failure.code,
      error,
      durationMs: failure.durationMs ?? performance.now() - this.#startedAt,
      ...(failure.ttftMs === null || failure.ttftMs === undefined
        ? {}
        : { ttftMs: failure.ttftMs }),
      ...(failure.responseBytes === undefined
        ? {}
        : { responseBytes: failure.responseBytes }),
      ...(failure.httpStatus === undefined
        ? {}
        : { httpStatus: failure.httpStatus }),
      ...(failure.providerErrorCode
        ? { providerErrorCode: failure.providerErrorCode }
        : {}),
      ...(failure.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
      ...usageFields(failure.usage),
    })
    associateDiagnosticId(error, result?.diagnosticId)
  }
}

function usageFields(usage: ProviderUsage | undefined) {
  return usage
    ? {
        ...(usage.promptTokens === undefined
          ? {}
          : { promptTokens: usage.promptTokens }),
        ...(usage.completionTokens === undefined
          ? {}
          : { completionTokens: usage.completionTokens }),
        ...(usage.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: usage.reasoningTokens }),
        ...(usage.totalTokens === undefined
          ? {}
          : { totalTokens: usage.totalTokens }),
        ...(usage.cacheHitTokens === undefined
          ? {}
          : { cacheHitTokens: usage.cacheHitTokens }),
        ...(usage.cacheMissTokens === undefined
          ? {}
          : { cacheMissTokens: usage.cacheMissTokens }),
      }
    : {}
}
