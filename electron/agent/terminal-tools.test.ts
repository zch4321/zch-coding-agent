import { describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { TerminalPool } from '../terminal/pool'
import { evaluatePolicy } from './policy-engine'
import { registerTerminalTools } from './terminal-tools'
import { ToolRegistry } from './tool-registry'

function definitions() {
  const registry = new ToolRegistry()
  registerTerminalTools(registry, {} as TerminalPool, () => 100_000)
  return registry
}

function outcome(
  toolId: string,
  mode: 'readonly' | 'auto' | 'confirm' | 'yolo',
) {
  const definition = definitions().get(toolId)

  if (!definition) {
    throw new Error(`Missing terminal tool: ${toolId}`)
  }

  return evaluatePolicy({
    mode,
    definition,
    effectiveRisk: definition.defaultRisk,
    policySignals: [],
    rememberedRules: [],
    builtinPolicies: true,
    workspace: 'F:/workspace',
    args: {},
    callId: 'call:terminal-policy' as CallId,
  }).kind
}

describe('terminal tool permission matrix', () => {
  it.each(['terminal_open', 'terminal_send', 'terminal_close'])(
    'routes %s through side-effect policy',
    (toolId) => {
      expect(outcome(toolId, 'readonly')).toBe('deny')
      expect(outcome(toolId, 'auto')).toBe('model')
      expect(outcome(toolId, 'confirm')).toBe('review')
      expect(outcome(toolId, 'yolo')).toBe('allow')
    },
  )

  it.each(['terminal_read', 'terminal_list', 'terminal_resize'])(
    'fast-paths %s as an owned read-only operation',
    (toolId) => {
      expect(outcome(toolId, 'readonly')).toBe('allow')
      expect(outcome(toolId, 'auto')).toBe('allow')
      expect(outcome(toolId, 'confirm')).toBe('allow')
      expect(outcome(toolId, 'yolo')).toBe('allow')
    },
  )
})
