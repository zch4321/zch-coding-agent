import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectMetadataStore } from './project-metadata-store'

const directories: string[] = []

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-project-'))
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

describe('ProjectMetadataStore', () => {
  it('creates project-local metadata without editing .gitignore', async () => {
    const directory = await workspace()
    await writeFile(
      path.join(directory, '.gitignore'),
      'node_modules\n',
      'utf8',
    )
    const store = new ProjectMetadataStore()

    const snapshot = await store.get(directory)

    expect(snapshot.path).toBe('.zch/project-model.json')
    expect(snapshot.gitIgnoreRecommended).toBe(true)
    expect(snapshot.project.workspaceRoot).toBe(path.resolve(directory))
    expect(snapshot.project.serena.command).toBe('serena')
    expect(snapshot.project.backendBindings.length).toBeGreaterThan(0)
    expect(snapshot.project.backendBindings[0]?.capabilities).toContain(
      'symbol_overview',
    )
    expect(snapshot.project.backendBindings[0]?.capabilities).not.toContain(
      'diagnostics',
    )
    expect(await readFile(path.join(directory, '.gitignore'), 'utf8')).toBe(
      'node_modules\n',
    )
  })

  it('saves modules and reports when .zch is ignored', async () => {
    const directory = await workspace()
    await writeFile(path.join(directory, '.gitignore'), '.zch/\n', 'utf8')
    const store = new ProjectMetadataStore()
    const snapshot = await store.get(directory)

    const saved = await store.save(directory, {
      ...snapshot.project,
      modules: [
        {
          id: 'frontend',
          root: 'frontend',
          name: 'frontend',
          languages: ['typescript'],
          manifests: ['frontend/package.json'],
          sourceRoots: ['frontend/src'],
          testRoots: [],
          excludedRoots: ['frontend/node_modules'],
          backendHints: ['serena'],
          source: 'agent-set',
          confidence: 0.9,
          fingerprint: 'fingerprint',
          updatedAt: new Date().toISOString(),
        },
      ],
      defaultModuleId: 'frontend',
    })

    expect(saved.gitIgnoreRecommended).toBe(false)
    expect(saved.project.modules[0]?.id).toBe('frontend')
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, '.zch', 'project-model.json'),
          'utf8',
        ),
      ).project.defaultModuleId,
    ).toBe('frontend')
  })
})
