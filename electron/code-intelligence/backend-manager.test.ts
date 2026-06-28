import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodeIntelligenceResult,
  ProjectModel,
} from '../../shared/project-model'
import { ProjectMetadataStore } from '../project/project-metadata-store'
import { CodeBackendManager } from './backend-manager'
import type { SerenaMcpAdapter } from './serena-mcp-adapter'

const directories: string[] = []

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-code-backend-'))
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

function enabledProject(project: ProjectModel): ProjectModel {
  return {
    ...project,
    modules: [
      {
        id: 'root',
        root: '.',
        name: 'workspace',
        languages: ['typescript'],
        manifests: ['package.json'],
        sourceRoots: [],
        testRoots: [],
        excludedRoots: [],
        backendHints: ['serena'],
        source: 'agent-set',
        confidence: 0.9,
        fingerprint: 'fingerprint',
        updatedAt: new Date().toISOString(),
      },
    ],
    defaultModuleId: 'root',
    serena: { ...project.serena, enabled: true },
    backendBindings: project.backendBindings.map((binding) => ({
      ...binding,
      enabled: true,
    })),
  }
}

describe('CodeBackendManager', () => {
  it('returns unsupported when no backend binding is enabled', async () => {
    const directory = await workspace()
    await writeFile(path.join(directory, 'app.ts'), 'export class App {}\n')
    const projectMetadata = new ProjectMetadataStore()
    const manager = new CodeBackendManager({ projectMetadata })

    const result = await manager.query({
      capability: 'symbol_overview',
      workspace: directory,
      path: 'app.ts',
    })

    expect(result.precision).toBe('unsupported')
    expect(result.code).toBe('BACKEND_UNAVAILABLE')
    expect(result.message).toContain('No enabled code intelligence backend')
  })

  it('routes enabled semantic queries to Serena', async () => {
    const directory = await workspace()
    await writeFile(path.join(directory, 'app.ts'), 'export class App {}\n')
    const projectMetadata = new ProjectMetadataStore()
    const snapshot = await projectMetadata.get(directory)
    await projectMetadata.save(directory, enabledProject(snapshot.project))
    const expected: CodeIntelligenceResult = {
      backendId: 'serena',
      capability: 'symbol_overview',
      precision: 'semantic',
      source: 'test',
      truncated: false,
      items: [{ name: 'App', kind: 'class' }],
    }
    const query = vi.fn(async () => expected)
    const fakeSerena = {
      status: vi.fn(),
      restart: vi.fn(),
      query,
      dispose: vi.fn(),
    } as unknown as SerenaMcpAdapter
    const manager = new CodeBackendManager({
      projectMetadata,
      serena: fakeSerena,
    })

    const result = await manager.query({
      capability: 'symbol_overview',
      workspace: directory,
      path: 'app.ts',
    })

    expect(result).toBe(expected)
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        serena: expect.objectContaining({ enabled: true }),
      }),
      expect.objectContaining({
        capability: 'symbol_overview',
        path: 'app.ts',
        moduleId: 'root',
      }),
    )
  })

  it('rejects file-only semantic queries for directories', async () => {
    const directory = await workspace()
    const projectMetadata = new ProjectMetadataStore()
    const snapshot = await projectMetadata.get(directory)
    await projectMetadata.save(directory, enabledProject(snapshot.project))
    const manager = new CodeBackendManager({ projectMetadata })

    const result = await manager.query({
      capability: 'symbol_overview',
      workspace: directory,
      path: '.',
    })

    expect(result.precision).toBe('unsupported')
    expect(result.code).toBe('PATH_NOT_FILE')
  })

  it('returns unsupported capability when the configured backend lacks diagnostics', async () => {
    const directory = await workspace()
    await writeFile(path.join(directory, 'app.ts'), 'export class App {}\n')
    const snapshot = await new ProjectMetadataStore().get(directory)
    const project = enabledProject(snapshot.project)
    project.backendBindings = project.backendBindings.map((binding) => ({
      ...binding,
      capabilities: ['symbol_overview'],
    }))
    const projectMetadata = {
      get: vi.fn(async () => ({
        project,
        path: '.zch/project-model.json',
        gitIgnoreRecommended: false,
      })),
    } as unknown as ProjectMetadataStore
    const manager = new CodeBackendManager({ projectMetadata })

    const result = await manager.query({
      capability: 'diagnostics',
      workspace: directory,
      path: 'app.ts',
    })

    expect(result.precision).toBe('unsupported')
    expect(result.code).toBe('UNSUPPORTED_CAPABILITY')
  })
})
