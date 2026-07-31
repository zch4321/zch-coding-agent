import { describe, expect, it } from 'vitest'
import {
  formatToolResultDisplay,
  toolResultDisplayContent,
} from './tool-result-display'

describe('tool result display', () => {
  it('extracts content from a live success envelope', () => {
    expect(
      toolResultDisplayContent({
        status: 'ok',
        content: { path: 'src/main.ts', operation: 'read' },
        truncated: false,
        totalBytes: 42,
      }),
    ).toEqual({ path: 'src/main.ts', operation: 'read' })
  })

  it('extracts content from a durable JSON message part', () => {
    expect(
      toolResultDisplayContent({
        type: 'tool_result',
        callId: 'call:durable',
        isError: false,
        content: [
          {
            type: 'json',
            value: {
              status: 'ok',
              content: 'plain terminal output',
              truncated: false,
            },
          },
        ],
      }),
    ).toBe('plain terminal output')
  })

  it('keeps a readable message for failures without content', () => {
    expect(
      toolResultDisplayContent({
        status: 'error',
        code: 'TOOL_FAILED',
        message: 'Tool execution failed',
        retryable: false,
      }),
    ).toBe('Tool execution failed')
  })

  it('renders string content without JSON quotes', () => {
    expect(formatToolResultDisplay('line one\nline two')).toBe(
      'line one\nline two',
    )
  })
})
