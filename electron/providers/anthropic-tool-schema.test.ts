import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../shared/json'
import { registerOrchestrationTools } from '../session/orchestration-tools'
import { ToolRegistry } from '../tools/tool-registry'
import { projectAnthropicToolInputSchema } from './anthropic-tool-schema'
import type { ProviderToolDefinition } from './provider'

function conditionalTool(
  keyword: 'oneOf' | 'allOf' | 'anyOf',
): ProviderToolDefinition {
  return {
    name: 'conditional_tool',
    description: 'Exercise a conditional schema',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        result: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
        _agent_intent: { type: 'string' },
      },
      required: ['status', '_agent_intent'],
      additionalProperties: false,
      [keyword]: [
        {
          if: {
            properties: { status: { const: 'completed' } },
            required: ['status'],
          },
          then: { required: ['result'] },
        },
      ],
    },
    intentParameter: '_agent_intent',
  }
}

describe('Anthropic Tool schema projection', () => {
  it.each(['oneOf', 'allOf', 'anyOf'] as const)(
    'removes a compatible top-level %s without mutating the source schema',
    (keyword) => {
      const tool = conditionalTool(keyword)
      const originalSchema = structuredClone(tool.inputSchema)

      const projected = projectAnthropicToolInputSchema(tool) as JsonObject
      expect(projected).not.toHaveProperty(keyword)
      expect((projected.properties as JsonObject).result).toHaveProperty(
        'anyOf',
      )
      expect(tool.inputSchema).toEqual(originalSchema)
    },
  )

  it('rejects a projection that would hide branch-only properties', () => {
    const tool: ProviderToolDefinition = {
      name: 'union_tool',
      description: 'Exercise a branch-owned property',
      inputSchema: {
        type: 'object',
        properties: {
          _agent_intent: { type: 'string' },
        },
        required: ['_agent_intent'],
        additionalProperties: false,
        oneOf: [
          {
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        ],
      },
      intentParameter: '_agent_intent',
    }

    expect(() => projectAnthropicToolInputSchema(tool)).toThrow(
      'Anthropic tool union_tool input schema cannot safely remove top-level oneOf because the root object does not declare: path',
    )
  })

  it('projects the registered plan_update schema without weakening its local contract', () => {
    const registry = new ToolRegistry()
    registerOrchestrationTools(registry, {
      getSession: () => undefined,
      emit: () => undefined,
    })
    const planUpdate = registry
      .providerDefinitions()
      .find((tool) => tool.name === 'plan_update')
    expect(planUpdate?.inputSchema).toHaveProperty('allOf')
    if (!planUpdate) throw new Error('plan_update was not registered')

    expect(projectAnthropicToolInputSchema(planUpdate)).not.toHaveProperty(
      'allOf',
    )
    expect(planUpdate.inputSchema).toHaveProperty('allOf')
  })
})
