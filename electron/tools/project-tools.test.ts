import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from './types'
import { ToolRegistry } from './tool-registry'
import { registerProjectTools } from './project-tools'
import { ProjectMetadataStore } from '../project/project-metadata-store'

const directories: string[] = []

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-project-tools-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  )
})

function context(directory: string): ToolExecutionContext {
  return {
    sessionId: 'session:test' as never,
    runId: 'run:test' as never,
    workspace: { canonicalPath: directory },
    signal: new AbortController().signal,
    approvedCall: {} as never,
  }
}

describe('project tools', () => {
  it('registers project metadata tools as readonly-safe metadata tools', () => {
    const registry = new ToolRegistry()
    registerProjectTools(registry, new ProjectMetadataStore())

    expect(registry.get('project_set_modules')?.effects).toEqual([
      'workspace.metadata.write',
    ])
    expect(registry.get('project_get_modules')?.defaultRisk).toBe('low')
  })

  it('sets modules in .zch metadata with agent-set source', async () => {
    const directory = await workspace()
    const registry = new ToolRegistry()
    registerProjectTools(registry, new ProjectMetadataStore())
    const tool = registry.get('project_set_modules')

    const result = await tool?.execute(
      {
        modules: [
          {
            root: '.',
            languages: ['typescript'],
            manifests: ['package.json'],
          },
        ],
      },
      context(directory),
    )

    expect(result?.status).toBe('ok')
    expect(
      result?.status === 'ok'
        ? (
            result.content as {
              project: { modules: Array<{ source: string }> }
            }
          ).project.modules[0]?.source
        : undefined,
    ).toBe('agent-set')
  })

  it('allows clearing the module list in .zch metadata', async () => {
    const directory = await workspace()
    const registry = new ToolRegistry()
    registerProjectTools(registry, new ProjectMetadataStore())
    const tool = registry.get('project_set_modules')

    const result = await tool?.execute({ modules: [] }, context(directory))

    expect(result?.status).toBe('ok')
    expect(
      result?.status === 'ok'
        ? (result.content as { project: { modules: unknown[] } }).project
            .modules
        : undefined,
    ).toEqual([])
  })
})
