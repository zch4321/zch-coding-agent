import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { ProjectModel } from '../../shared/project-model'
import { ToolRegistry } from '../tools/tool-registry'
import type { ToolDefinition } from '../tools/types'
import {
  projectHasCodeIntelligence,
  resolveSessionToolCatalog,
} from './session-tool-catalog'

function project(
  enabled: boolean,
): Pick<ProjectModel, 'serena' | 'backendBindings'> {
  return {
    serena: {
      id: 'serena',
      enabled,
      command: 'serena',
      context: 'ide-assistant',
      projectMode: 'workspacePath',
      openWebDashboard: false,
      extraArgs: [],
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 30_000,
      languages: ['typescript'],
    },
    backendBindings: [
      {
        id: 'serena:typescript',
        language: 'typescript',
        backendId: 'serena',
        backendKind: 'serena-mcp',
        enabled,
        capabilities: ['definition'],
        configuredBy: 'user',
        updatedAt: new Date(0).toISOString(),
      },
    ],
  }
}

function registry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const id of ['read_file', 'code_find_definition']) {
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
  it('recognizes only enabled Serena bindings with capabilities', () => {
    expect(projectHasCodeIntelligence(project(false))).toBe(false)
    expect(projectHasCodeIntelligence(project(true))).toBe(true)
  })

  it('omits code tools while Serena is disabled', async () => {
    const catalog = await resolveSessionToolCatalog({
      registry: registry(),
      workspace: process.cwd(),
      projectMetadata: {
        get: async () => ({ project: project(false) }) as never,
      },
    })

    expect(catalog.names).toEqual(['read_file'])
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([
      'read_file',
    ])
  })

  it('exposes code tools when Serena is enabled', async () => {
    const catalog = await resolveSessionToolCatalog({
      registry: registry(),
      workspace: process.cwd(),
      projectMetadata: {
        get: async () => ({ project: project(true) }) as never,
      },
    })

    expect(catalog.names).toEqual(['read_file', 'code_find_definition'])
  })
})
