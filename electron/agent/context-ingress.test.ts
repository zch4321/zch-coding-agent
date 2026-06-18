import { describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { ToolCall, ToolResult } from '../tools/types'
import { ContextIngressFilter } from './context-ingress'

const call: ToolCall = {
  id: 'call:ingress' as CallId,
  toolId: 'read_file',
  args: { path: '.env.local' },
  reason: 'Read configuration',
}
const result: ToolResult = {
  status: 'ok',
  content: {
    path: '.env.local',
    content: 'TOKEN=secret-value',
  },
}

describe('P3 context ingress modes', () => {
  it.each([
    ['off', 'allow'],
    ['warn', 'warn'],
    ['confirm', 'confirm'],
  ] as const)('%s mode returns %s', (mode, expected) => {
    const decision = new ContextIngressFilter().evaluate(
      {
        mode,
        pathGlobs: ['.env*'],
        contentPatterns: ['TOKEN='],
      },
      { call, result },
    )

    expect(decision.action).toBe(expected)

    if (decision.action !== 'allow') {
      expect(decision.signals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'sensitive_path' }),
          expect.objectContaining({ code: 'sensitive_content' }),
        ]),
      )
    }
  })
})
