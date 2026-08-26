import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../tools/tool-registry'
import type { ToolDefinition } from '../tools/types'
import { SwarmRunArgsSchema } from '../../shared/swarm'
import { resolveSessionToolCatalog } from './session-tool-catalog'

function registry(
  ids: readonly string[] = ['read_file', 'code_find_definition'],
): ToolRegistry {
  const registry = new ToolRegistry()
  for (const id of ids) {
    registry.registerTool({
      id,
      description: `${id} fixture`,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      effects: ['filesystem.read'],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: null }
      },
    } satisfies ToolDefinition)
  }
  return registry
}

describe('session tool catalog', () => {
  it('omits project metadata and code-intelligence tools unconditionally', async () => {
    const catalog = await resolveSessionToolCatalog({
      registry: registry([
        'read_file',
        'project_get_modules',
        'project_detect_modules',
        'project_set_modules',
        'project_update_module',
        'code_symbol_overview',
        'code_find_definition',
        'code_find_references',
        'code_workspace_symbols',
        'code_diagnostics',
      ]),
    })

    expect(catalog.names).toEqual(['read_file'])
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      'read_file',
    ])
  })

  it('applies child allowlist and Git availability together', async () => {
    const catalog = await resolveSessionToolCatalog({
      registry: registry([
        'read_file',
        'git_status',
        'git_refs',
        'subagent_run',
        'code_find_definition',
      ]),
      allowedToolIds: new Set([
        'read_file',
        'git_status',
        'git_refs',
        'subagent_run',
        'code_find_definition',
      ]),
      subagentsEnabled: false,
      gitToolsEnabled: false,
    })

    expect(catalog.names).toEqual(['read_file'])
  })

  it('exposes the fixed-schema Swarm only for an eligible Run', async () => {
    const tools = registry(['read_file'])
    tools.registerTool({
      id: 'swarm_run',
      description: 'Swarm fixture',
      inputSchema: SwarmRunArgsSchema,
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: null,
      maxOutputBytes: 1_024,
      async execute() {
        return { status: 'ok', content: null }
      },
    })

    expect(
      (
        await resolveSessionToolCatalog({
          registry: tools,
          subagentsEnabled: true,
        })
      ).names,
    ).toEqual(['read_file'])

    const catalog = await resolveSessionToolCatalog({
      registry: tools,
      subagentsEnabled: true,
      swarmEnabled: true,
    })
    const swarm = catalog.definitions.find(
      (definition) => definition.name === 'swarm_run',
    )!
    const schema = swarm.inputSchema as {
      properties: {
        tasks: {
          maxItems: number
          items: { properties: { agentCount: { maximum: number } } }
        }
      }
    }
    expect(catalog.names).toEqual(['read_file', 'swarm_run'])
    expect(schema.properties.tasks.maxItems).toBe(32)
    expect(schema.properties.tasks.items.properties.agentCount.maximum).toBe(32)
    expect(SwarmRunArgsSchema.properties.tasks.maxItems).toBe(32)
    expect(
      SwarmRunArgsSchema.properties.tasks.items.properties.agentCount.maximum,
    ).toBe(32)
  })
})
