import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import type { CallId } from '../../shared/ids'
import { renderToolResultContent } from '../../shared/message'
import { projectToolResultForModel } from './tool-result-projection'
import type { ToolCall, ToolDefinition } from './types'

const ArgsSchema = Type.Object(
  { path: Type.String() },
  { additionalProperties: false },
)

function call(args = { path: 'README.md' }): ToolCall {
  return {
    id: 'call:projection' as CallId,
    toolId: 'fixture',
    args,
    reason: 'test',
  }
}

describe('Tool Result projection', () => {
  it('projects default strings, empty output, JSON values, and multiple parts', () => {
    expect(
      projectToolResultForModel({
        call: call(),
        result: { status: 'ok', content: 'plain text' },
      }).content,
    ).toEqual([{ type: 'text', text: 'plain text' }])
    expect(
      projectToolResultForModel({
        call: call(),
        result: { status: 'ok', content: '' },
      }).content,
    ).toEqual([{ type: 'text', text: '[no output]' }])
    expect(
      projectToolResultForModel({
        call: call(),
        result: {
          status: 'ok',
          content: { count: 2, omitted: undefined } as never,
        },
      }).content,
    ).toEqual([{ type: 'json', value: { count: 2 } }])

    const definition: ToolDefinition<typeof ArgsSchema> = {
      id: 'fixture',
      description: 'fixture',
      inputSchema: ArgsSchema,
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_000,
      projectResultForModel: () => [
        { type: 'text', text: 'alpha' },
        { type: 'json', value: { beta: true } },
      ],
      async execute() {
        return { status: 'ok', content: null }
      },
    }
    const projected = projectToolResultForModel({
      call: call(),
      definition,
      result: { status: 'ok', content: null },
    })
    expect(renderToolResultContent(projected.content)).toBe(
      'alpha\n{"beta":true}',
    )
  })

  it.each([
    [
      { status: 'error', code: 'BROKEN', message: 'failed', retryable: true },
      'ERROR BROKEN: failed\n[retryable=true]',
    ],
    [{ status: 'denied', message: 'not allowed' }, 'DENIED: not allowed'],
    [{ status: 'cancelled', message: 'stopped' }, 'CANCELLED: stopped'],
    [{ status: 'timeout', message: 'too slow' }, 'TIMEOUT: too slow'],
  ] as const)('projects a canonical error message', (result, expected) => {
    expect(
      projectToolResultForModel({
        call: call(),
        result,
      }),
    ).toEqual({
      content: [{ type: 'text', text: expected }],
      isError: true,
      truncated: false,
    })
  })

  it('bounds oversized errors and marks the projection as truncated', () => {
    const projected = projectToolResultForModel({
      call: call(),
      result: {
        status: 'error',
        code: 'OVERSIZED',
        message: `head-${'中'.repeat(70_000)}-tail`,
        retryable: false,
      },
    })

    expect(projected.truncated).toBe(true)
    expect(projected.content[0]).toMatchObject({ type: 'text' })
    expect(renderToolResultContent(projected.content)).toContain('head-')
    expect(renderToolResultContent(projected.content)).toContain('-tail')
    expect(renderToolResultContent(projected.content)).toContain(
      '... output truncated ...',
    )
  })

  it('passes copies to a projector and safely falls back after failure', () => {
    const diagnostic = vi.fn()
    const originalResult = { status: 'ok' as const, content: { value: 1 } }
    const originalCall = call()
    const definition: ToolDefinition<typeof ArgsSchema> = {
      id: 'fixture',
      description: 'fixture',
      inputSchema: ArgsSchema,
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_000,
      projectResultForModel(result, args) {
        ;(result.content as { value: number }).value = 9
        args.path = 'changed'
        return [{ type: 'binary' }] as never
      },
      async execute() {
        return originalResult
      },
    }

    expect(
      projectToolResultForModel({
        call: originalCall,
        definition,
        result: originalResult,
        onDiagnostic: diagnostic,
      }),
    ).toEqual({
      content: [{ type: 'json', value: { value: 1 } }],
      isError: false,
      truncated: false,
    })
    expect(originalResult.content).toEqual({ value: 1 })
    expect(originalCall.args).toEqual({ path: 'README.md' })
    expect(diagnostic).toHaveBeenCalledOnce()
  })

  it('hides the internal byte-bound envelope behind one text part', () => {
    const projected = projectToolResultForModel({
      call: call(),
      result: {
        status: 'ok',
        content: {
          truncated: true,
          preview: 'bounded body',
          message: 'internal byte limit',
        },
        truncated: true,
        totalBytes: 10_000,
      },
    })
    expect(projected).toEqual({
      content: [
        {
          type: 'text',
          text: 'bounded body\n\n[truncated=true; byteLimitExceeded=true]',
        },
      ],
      isError: false,
      truncated: true,
    })
  })
})
