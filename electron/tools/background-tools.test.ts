import { describe, expect, it, vi } from 'vitest'
import type { CallId } from '../../shared/ids'
import { evaluatePolicy } from '../permission/policy-engine'
import { registerBackgroundTools } from './background-tools'
import { ToolRegistry } from './tool-registry'

function registry() {
  const tools = new ToolRegistry()
  registerBackgroundTools(tools, {
    wait: vi.fn(),
    list: vi.fn(),
    cancel: vi.fn(),
    cancelSession: vi.fn(),
  })
  return tools
}

describe('background tools', () => {
  it('publishes top-level object schemas without combinators', () => {
    const tools = registry()
    for (const id of [
      'background_wait',
      'background_list',
      'background_cancel',
    ]) {
      const schema = tools
        .providerDefinitions()
        .find((definition) => definition.name === id)?.inputSchema as Record<
        string,
        unknown
      >
      expect(schema.type).toBe('object')
      expect(schema).not.toHaveProperty('oneOf')
      expect(schema).not.toHaveProperty('anyOf')
      expect(schema).not.toHaveProperty('allOf')
    }
  })

  it('caps mixed Terminal waits and keeps cancellation approval-free', () => {
    const tools = registry()
    const wait = tools.get('background_wait')!
    expect(
      wait.validateArgs?.({
        targets: [{ type: 'terminal', id: '1' }],
        timeoutMs: 60_001,
      } as never),
    ).toContain('60000')
    const cancel = tools.get('background_cancel')!
    for (const mode of ['readonly', 'auto', 'confirm', 'yolo'] as const) {
      expect(
        evaluatePolicy({
          mode,
          definition: cancel,
          effectiveRisk: cancel.defaultRisk,
          policySignals: [],
          rememberedRules: [],
          builtinPolicies: true,
          workspace: '/workspace',
          args: {},
          callId: 'call:background' as CallId,
        }).kind,
      ).toBe('allow')
    }
  })
})
