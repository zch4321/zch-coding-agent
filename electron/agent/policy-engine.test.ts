import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { PermissionMode, RememberedRule } from '../../shared/config'
import type { CallId } from '../../shared/ids'
import type { ToolDefinition } from '../tools/types'
import { evaluatePolicy } from './policy-engine'

const EmptyArgsSchema = Type.Object({}, { additionalProperties: false })

function definition(
  effect: 'read' | 'write' | 'delete',
  risk: 'low' | 'review' | 'high',
): ToolDefinition<typeof EmptyArgsSchema> {
  return {
    id: `${effect}_${risk}`,
    description: 'matrix fixture',
    inputSchema: EmptyArgsSchema,
    effects: [
      effect === 'read'
        ? 'filesystem.read'
        : effect === 'write'
          ? 'filesystem.write'
          : 'filesystem.delete',
    ],
    defaultRisk: risk,
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 1_000,
    async execute() {
      return { status: 'ok', content: null }
    },
  }
}

const modes: PermissionMode[] = ['readonly', 'auto', 'confirm', 'yolo']
const effects = ['read', 'write', 'delete'] as const
const risks = ['low', 'review', 'high'] as const
const matrix = modes.flatMap((mode) =>
  effects.flatMap((effect) =>
    risks.map((risk) => {
      let expected: 'allow' | 'deny' | 'review' | 'model'

      if (effect === 'read') {
        expected = risk === 'low' ? 'allow' : 'review'
      } else if (mode === 'readonly') {
        expected = 'deny'
      } else if (mode === 'yolo') {
        expected = 'allow'
      } else if (mode === 'confirm') {
        expected = 'review'
      } else {
        expected = risk === 'high' ? 'review' : 'model'
      }

      return { mode, effect, risk, expected }
    }),
  ),
)

function evaluate(input: {
  mode: PermissionMode
  effect: (typeof effects)[number]
  risk: (typeof risks)[number]
  rules?: RememberedRule[]
  danger?: boolean
}) {
  const tool = definition(input.effect, input.risk)
  return evaluatePolicy({
    mode: input.mode,
    definition: tool,
    effectiveRisk: input.risk,
    policySignals: input.danger
      ? [{ code: 'danger', severity: 'danger', detail: 'danger fixture' }]
      : [],
    rememberedRules: input.rules ?? [],
    builtinPolicies: true,
    workspace: 'F:/workspace',
    args: {},
    callId: 'call:matrix' as CallId,
  })
}

describe('P3 policy engine', () => {
  it('contains at least 30 deterministic matrix rows', () => {
    expect(matrix.length).toBeGreaterThanOrEqual(30)
  })

  it.each(matrix)(
    '$mode $effect $risk -> $expected',
    ({ mode, effect, risk, expected }) => {
      expect(evaluate({ mode, effect, risk }).kind).toBe(expected)
    },
  )

  it('sends danger signals to human review in Auto but Yolo skips them', () => {
    expect(
      evaluate({ mode: 'auto', effect: 'write', risk: 'low', danger: true })
        .kind,
    ).toBe('review')
    expect(
      evaluate({ mode: 'yolo', effect: 'write', risk: 'high', danger: true })
        .kind,
    ).toBe('allow')
  })

  it('applies active remembered allow rules only in Auto mode', () => {
    const tool = definition('write', 'review')
    const rule: RememberedRule = {
      id: 'rule:test',
      effect: 'allow',
      toolId: tool.id,
      workspaceScope: 'F:/workspace',
      argConstraints: {},
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdFromCallId: 'call:source',
    }
    const base = {
      definition: tool,
      effectiveRisk: 'review' as const,
      policySignals: [],
      rememberedRules: [rule],
      builtinPolicies: true,
      workspace: 'F:/workspace',
      args: {},
      callId: 'call:rule' as CallId,
    }

    expect(evaluatePolicy({ ...base, mode: 'auto' })).toMatchObject({
      kind: 'allow',
      approvedBy: 'remembered',
    })
    expect(evaluatePolicy({ ...base, mode: 'confirm' }).kind).toBe('review')
  })
})
