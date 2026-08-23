import { describe, expect, it } from 'vitest'
import { ProviderTransportError } from '../providers/http-sse-transport'
import { ProviderCompletionError } from '../providers/provider'
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
})
