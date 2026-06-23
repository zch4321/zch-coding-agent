import { describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { registerProcessTools } from './process-tools'
import { ToolExecutor, ToolRegistry } from './tool-registry'

function harness() {
  const registry = new ToolRegistry()
  registerProcessTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
  return { registry, executor: new ToolExecutor(registry) }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

describe('run_command provider schema', () => {
  it('exposes a top-level object schema accepted by DeepSeek', () => {
    const { registry } = harness()
    const definition = registry.get('run_command')

    expect(definition?.inputSchema).toMatchObject({
      type: 'object',
      required: ['mode'],
      properties: {
        mode: expect.any(Object),
        executable: expect.any(Object),
        args: expect.any(Object),
        command: expect.any(Object),
      },
    })
    expect(definition?.inputSchema).not.toHaveProperty('anyOf')

    const providerDefinition = registry.providerDefinitions()[0]
    expect(providerDefinition).toMatchObject({
      function: {
        'x-agent-intent-property': '_agent_intent',
        parameters: {
          required: expect.arrayContaining(['mode', '_agent_intent']),
          properties: { _agent_intent: expect.any(Object) },
        },
      },
    })
    expect(definition?.inputSchema).not.toHaveProperty(
      'properties._agent_intent',
    )
  })

  it.each([
    { mode: 'process' },
    { mode: 'process', executable: 'node', command: 'node --version' },
    { mode: 'shell' },
    { mode: 'shell', command: 'node --version', args: ['--version'] },
  ])('rejects an invalid mode-specific argument combination: %j', (args) => {
    const { executor } = harness()
    const inspected = executor.inspectCall({
      id: 'call:run-command-schema' as CallId,
      toolId: 'run_command',
      args: json(args),
      reason: 'test validation',
    })

    expect(inspected.ok).toBe(false)

    if (!inspected.ok) {
      expect(inspected.result).toMatchObject({
        status: 'error',
        code: 'INVALID_TOOL_ARGS',
      })
    }
  })

  it.each([
    { mode: 'process', executable: 'node', args: ['--version'] },
    { mode: 'shell', command: 'node --version' },
  ])('accepts a valid mode-specific argument combination: %j', (args) => {
    const { executor } = harness()
    expect(
      executor.inspectCall({
        id: 'call:run-command-schema' as CallId,
        toolId: 'run_command',
        args: json(args),
        reason: 'test validation',
      }).ok,
    ).toBe(true)
  })
})
