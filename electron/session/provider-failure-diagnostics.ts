import type {
  AgentExecutionId,
  CallId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { TraceLogger } from '../logging/logger'
import { createTraceFailureEvidence } from '../logging/failure-evidence'
import { diagnosticIdForError } from '../operational-logging/diagnostic-id'
import type { ProviderAttemptRecorder } from '../operational-logging/provider-attempt-recorder'
import { ProviderTransportError } from '../providers/http-sse-transport'
import type { ProviderResponseDiagnostics } from '../providers/provider'
import { redactJsonSecrets, toJsonValue } from './session-common'
import { classifyRunError } from './run-error-classifier'

export interface ProviderFailureTraceInput {
  logger: TraceLogger
  sessionId: SessionId
  runId: RunId
  callId: CallId
  agentExecutionId?: AgentExecutionId
  apiKey: string
  operation: 'main' | 'compact' | 'approval' | 'title' | 'model_catalog'
  error: unknown
  diagnostics?: ProviderResponseDiagnostics
  classification?: { stage: string; code: string }
}

/** Writes one bounded aggregate Provider failure to a Full Trace. */
export async function writeProviderFailureTrace(
  input: ProviderFailureTraceInput,
): Promise<void> {
  const transport = findProviderTransportError(input.error)
  const rawEvidence = transport?.evidence
    ? redactJsonSecrets(transport.evidence.content, [input.apiKey])
    : input.diagnostics
      ? JSON.stringify(
          redactJsonSecrets(input.diagnostics.rawResponse, [input.apiKey]),
        )
      : undefined
  await input.logger.write({
    type: 'llm.failure',
    sessionId: input.sessionId,
    runId: input.runId,
    callId: input.callId,
    ...(input.agentExecutionId
      ? { agentExecutionId: input.agentExecutionId }
      : {}),
    operation: input.operation,
    stage:
      input.classification?.stage ?? (transport ? 'transport' : 'completion'),
    code: input.classification?.code ?? classifyRunError(input.error).code,
    ...(diagnosticIdForError(input.error)
      ? { diagnosticId: diagnosticIdForError(input.error) }
      : {}),
    message: (
      redactJsonSecrets(
        input.error instanceof Error
          ? input.error.message
          : 'Provider request failed',
        [input.apiKey],
      ) as string
    ).slice(0, 2_048),
    ...(transport?.status === undefined
      ? {}
      : { httpStatus: transport.status }),
    ...(transport?.providerErrorCode
      ? { providerErrorCode: transport.providerErrorCode }
      : {}),
    ...(transport?.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: transport.retryAfterMs }),
    ...(transport?.requestId ? { requestId: transport.requestId } : {}),
    ...(input.diagnostics
      ? { timing: toJsonValue(input.diagnostics.timing) }
      : {}),
    ...(rawEvidence
      ? {
          evidence: createTraceFailureEvidence(
            transport?.evidence?.kind ?? 'invalid_completion',
            String(rawEvidence),
          ),
        }
      : {}),
  })
}

/** Records safe operational metadata for one failed Provider attempt. */
export function recordProviderAttemptFailure(
  recorder: ProviderAttemptRecorder,
  error: unknown,
  diagnostics?: ProviderResponseDiagnostics,
  code?: string,
): void {
  const transport = findProviderTransportError(error)
  recorder.failed(error, {
    code: code ?? classifyRunError(error).code,
    ...(transport?.status === undefined
      ? {}
      : { httpStatus: transport.status }),
    ...(transport?.providerErrorCode
      ? { providerErrorCode: transport.providerErrorCode }
      : {}),
    ...(transport?.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: transport.retryAfterMs }),
    ...(transport?.requestId ? { requestId: transport.requestId } : {}),
    ...(diagnostics
      ? {
          durationMs: diagnostics.timing.totalMs,
          ttftMs: diagnostics.timing.ttftMs,
          responseBytes: diagnostics.timing.responseBytes,
        }
      : transport?.evidence
        ? { responseBytes: Buffer.byteLength(transport.evidence.content) }
        : {}),
  })
}

/** Finds bounded transport metadata through a short error-cause chain. */
export function findProviderTransportError(
  error: unknown,
  depth = 0,
): ProviderTransportError | undefined {
  if (error instanceof ProviderTransportError) return error
  if (!error || typeof error !== 'object' || depth >= 3) return undefined
  return findProviderTransportError(Reflect.get(error, 'cause'), depth + 1)
}
