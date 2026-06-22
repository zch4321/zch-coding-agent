import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { PolicySignal } from '../../shared/agent-events'
import type { PermissionMode, RememberedRule } from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { CallId } from '../../shared/ids'
import type { ToolDefinition } from '../tools/types'

export type PolicyOutcome =
  | { kind: 'allow'; approvedBy: 'readonly' | 'policy' | 'remembered' | 'yolo' }
  | { kind: 'deny'; code: string; reason: string }
  | { kind: 'review'; reason: string }
  | { kind: 'model'; reason: string }

export interface PolicyInput {
  mode: PermissionMode
  definition: ToolDefinition
  effectiveRisk: 'low' | 'review' | 'high'
  policySignals: readonly PolicySignal[]
  rememberedRules: readonly RememberedRule[]
  builtinPolicies: boolean
  workspace: string
  args: JsonValue
  callId: CallId
  now?: Date
}

export function hasSideEffects(definition: ToolDefinition): boolean {
  return definition.effects.some(
    (effect) =>
      effect !== 'filesystem.read' &&
      effect !== 'terminal.read' &&
      effect !== 'instruction.read',
  )
}

function sameWorkspace(rule: RememberedRule, workspace: string): boolean {
  if (rule.workspaceScope === '*') {
    return true
  }

  const normalize = (value: string) => {
    let resolved = path.resolve(value)

    try {
      resolved = path.resolve(realpathSync.native(resolved))
    } catch {
      // Remembered rules may outlive their workspace directory.
    }

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(rule.workspaceScope) === normalize(workspace)
}

function matchesConstraints(constraints: JsonValue, args: JsonValue): boolean {
  if (
    !constraints ||
    typeof constraints !== 'object' ||
    Array.isArray(constraints)
  ) {
    return constraints === null
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return false
  }

  return Object.entries(constraints).every(([key, expected]) => {
    const actual = args[key]
    return JSON.stringify(actual) === JSON.stringify(expected)
  })
}

function matchingRule(input: PolicyInput): RememberedRule | undefined {
  const now = input.now ?? new Date()

  return input.rememberedRules.find(
    (rule) =>
      rule.toolId === input.definition.id &&
      sameWorkspace(rule, input.workspace) &&
      (!rule.expiresAt || new Date(rule.expiresAt) > now) &&
      matchesConstraints(rule.argConstraints, input.args),
  )
}

export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const sideEffects = hasSideEffects(input.definition)

  if (!sideEffects) {
    if (input.effectiveRisk === 'high') {
      return { kind: 'review', reason: 'A security hook raised risk to high' }
    }

    if (input.effectiveRisk === 'review') {
      return { kind: 'review', reason: 'The tool requires explicit review' }
    }

    return { kind: 'allow', approvedBy: 'readonly' }
  }

  if (input.mode === 'readonly') {
    return {
      kind: 'deny',
      code: 'READONLY_MODE',
      reason: 'ReadOnly mode denies tools with side effects',
    }
  }

  if (input.mode === 'yolo') {
    return { kind: 'allow', approvedBy: 'yolo' }
  }

  if (input.mode === 'confirm') {
    return {
      kind: 'review',
      reason: 'Confirm mode requires human approval for every side effect',
    }
  }

  if (
    input.builtinPolicies &&
    (input.effectiveRisk === 'high' ||
      input.policySignals.some((signal) => signal.severity === 'danger'))
  ) {
    return {
      kind: 'review',
      reason: 'Deterministic policy requires human review',
    }
  }

  const rule = matchingRule(input)

  if (rule?.effect === 'review') {
    return {
      kind: 'review',
      reason: `Remembered rule ${rule.id} requires review`,
    }
  }

  if (rule?.effect === 'allow') {
    return { kind: 'allow', approvedBy: 'remembered' }
  }

  return {
    kind: 'model',
    reason: 'Auto mode delegates this bounded action to the approval model',
  }
}
