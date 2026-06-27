import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { PermissionMode, RememberedRule } from '../../shared/config'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
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

function runCommandPolicy(args: JsonValue, danger = false) {
  const tool: ToolDefinition<typeof EmptyArgsSchema> = {
    id: 'run_command',
    description: 'process fixture',
    inputSchema: EmptyArgsSchema,
    effects: ['process.spawn'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 1_000,
    async execute() {
      return { status: 'ok', content: null }
    },
  }

  return evaluatePolicy({
    mode: 'auto',
    definition: tool,
    effectiveRisk: 'review',
    policySignals: danger
      ? [{ code: 'danger', severity: 'danger', detail: 'danger fixture' }]
      : [],
    rememberedRules: [],
    builtinPolicies: true,
    workspace: 'F:/workspace',
    args,
    callId: 'call:go-command' as CallId,
  })
}

function fileMutationPolicy(input: {
  toolId: 'create_file' | 'apply_patch' | 'delete_file'
  mode?: PermissionMode
  danger?: boolean
  builtinPolicies?: boolean
  rules?: RememberedRule[]
}) {
  const risk = input.toolId === 'delete_file' ? 'high' : 'review'
  const tool: ToolDefinition<typeof EmptyArgsSchema> = {
    id: input.toolId,
    description: 'file mutation fixture',
    inputSchema: EmptyArgsSchema,
    effects: [
      input.toolId === 'delete_file' ? 'filesystem.delete' : 'filesystem.write',
    ],
    defaultRisk: risk,
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 1_000,
    async execute() {
      return { status: 'ok', content: null }
    },
  }

  return evaluatePolicy({
    mode: input.mode ?? 'auto',
    definition: tool,
    effectiveRisk: risk,
    policySignals: input.danger
      ? [{ code: 'danger', severity: 'danger', detail: 'danger fixture' }]
      : [],
    rememberedRules: input.rules ?? [],
    builtinPolicies: input.builtinPolicies ?? true,
    workspace: 'F:/workspace',
    args: {},
    callId: 'call:file-mutation' as CallId,
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

  it.each(modes)(
    'auto-approves a low-risk vcs.read tool in %s mode',
    (mode) => {
      const tool: ToolDefinition<typeof EmptyArgsSchema> = {
        id: 'git_status',
        description: 'read-only git',
        inputSchema: EmptyArgsSchema,
        effects: ['vcs.read'],
        defaultRisk: 'low',
        supportsAbort: true,
        defaultTimeoutMs: 1_000,
        maxOutputBytes: 1_000,
        async execute() {
          return { status: 'ok', content: null }
        },
      }
      const outcome = evaluatePolicy({
        mode,
        definition: tool,
        effectiveRisk: 'low',
        policySignals: [],
        rememberedRules: [],
        builtinPolicies: true,
        workspace: 'F:/workspace',
        args: {},
        callId: 'call:vcs' as CallId,
      })

      expect(outcome.kind).toBe('allow')
      if (outcome.kind === 'allow') {
        expect(outcome.approvedBy).toBe('readonly')
      }
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

  it('delegates Go module maintenance commands to the Auto approval model', () => {
    expect(
      runCommandPolicy({
        mode: 'process',
        executable: 'go',
        args: ['mod', 'tidy'],
      }).kind,
    ).toBe('model')
    expect(
      runCommandPolicy({
        mode: 'process',
        executable: 'go',
        args: ['get', 'example.com/module@latest'],
      }).kind,
    ).toBe('model')
    expect(
      runCommandPolicy({
        mode: 'shell',
        command: 'go mod tidy',
      }).kind,
    ).toBe('model')
    expect(
      runCommandPolicy(
        {
          mode: 'process',
          executable: 'go',
          args: ['mod', 'tidy'],
        },
        true,
      ).kind,
    ).toBe('review')
  })

  it('auto-allows bounded workspace write and patch file mutations by policy', () => {
    expect(fileMutationPolicy({ toolId: 'create_file' })).toMatchObject({
      kind: 'allow',
      approvedBy: 'policy',
    })
    expect(fileMutationPolicy({ toolId: 'apply_patch' })).toMatchObject({
      kind: 'allow',
      approvedBy: 'policy',
    })
    expect(
      fileMutationPolicy({ toolId: 'create_file', mode: 'confirm' }).kind,
    ).toBe('review')
    expect(
      fileMutationPolicy({ toolId: 'apply_patch', danger: true }).kind,
    ).toBe('review')
    expect(fileMutationPolicy({ toolId: 'delete_file' }).kind).toBe('review')
    expect(
      fileMutationPolicy({
        toolId: 'create_file',
        builtinPolicies: false,
      }).kind,
    ).toBe('model')
    expect(
      fileMutationPolicy({
        toolId: 'create_file',
        rules: [
          {
            id: 'rule:file-review',
            effect: 'review',
            toolId: 'create_file',
            workspaceScope: 'F:/workspace',
            argConstraints: {},
            expiresAt: '2099-01-01T00:00:00.000Z',
            createdFromCallId: 'call:source',
          },
        ],
      }).kind,
    ).toBe('review')
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
    expect(
      evaluatePolicy({
        ...base,
        mode: 'auto',
        policySignals: [
          { code: 'danger', severity: 'danger', detail: 'danger fixture' },
        ],
      }).kind,
    ).toBe('review')
  })
})
