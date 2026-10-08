import { describe, expect, it } from 'vitest'
import { ProviderTransportError } from '../providers/http-sse-transport'
import {
  ProviderCompletionError,
  ProviderRequestError,
} from '../providers/provider'
import { associateDiagnosticCode } from '../operational-logging/diagnostic-id'
import { CompactionFailedError } from './session-compact-retry'
import { classifyRunError } from './run-error-classifier'

const diagnostics = {
  rawResponse: {},
  providerState: {},
  usage: {},
  timing: { ttftMs: null, totalMs: 1, responseBytes: 0 },
}

describe('classifyRunError', () => {
  it.each([
    ['HTTP_ERROR', 'PROVIDER_HTTP_ERROR'],
    ['NETWORK_ERROR', 'PROVIDER_NETWORK_ERROR'],
    ['TIMED_OUT', 'PROVIDER_TIMEOUT'],
    ['INVALID_SSE', 'PROVIDER_STREAM_INVALID'],
    ['INVALID_JSON', 'PROVIDER_JSON_INVALID'],
  ] as const)('maps %s to %s', (transportCode, runCode) => {
    expect(
      classifyRunError(
        new ProviderTransportError(transportCode, 'provider failed'),
      ).code,
    ).toBe(runCode)
  })

  it('classifies completion, configuration, compaction, and unknown failures', () => {
    expect(
      classifyRunError(
        new ProviderCompletionError('invalid completion', diagnostics),
      ).code,
    ).toBe('PROVIDER_COMPLETION_INVALID')
    expect(
      classifyRunError(new Error('Provider is not configured: missing')).code,
    ).toBe('PROVIDER_CONFIGURATION_ERROR')
    expect(
      classifyRunError(new Error('DeepSeek credential is not available')).code,
    ).toBe('PROVIDER_CONFIGURATION_ERROR')
    expect(
      classifyRunError(
        new CompactionFailedError(
          new ProviderTransportError('NETWORK_ERROR', 'network'),
        ),
      ).code,
    ).toBe('COMPACTION_FAILED')
    expect(classifyRunError(new Error('unexpected')).code).toBe('RUN_FAILED')
  })

  it('reports policy stops with an actionable message for both HTTP and streamed failures', () => {
    for (const error of [
      new ProviderRequestError(
        'Responses request failed',
        diagnostics,
        'misalignment_policy_violation',
      ),
      new ProviderTransportError('HTTP_ERROR', 'HTTP 403', 403, {
        providerErrorCode: 'misalignment_policy_violation',
      }),
    ]) {
      const classified = classifyRunError(error)
      expect(classified).toMatchObject({
        code: 'PROVIDER_POLICY_BLOCKED',
        message: expect.stringContaining('misalignment_policy_violation'),
      })
      associateDiagnosticCode(error, classified.code)
      expect(classifyRunError(error)).toEqual(classified)
    }
  })

  it('distinguishes explicit Provider request failures from invalid completions', () => {
    expect(
      classifyRunError(
        new ProviderRequestError(
          'failed',
          diagnostics,
          'invalid_request_error',
        ),
      ).code,
    ).toBe('PROVIDER_REQUEST_FAILED')
  })
})
