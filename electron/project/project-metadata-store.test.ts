import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSerenaLaunchArgs } from '../../shared/serena-launch'
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
    expect(snapshot.project.workspaceRoot).toBe(
      path.resolve(await realpath(directory)),
    )
    expect(snapshot.project.serena.command).toBe('serena')
    expect(snapshot.project.backendBindings.length).toBeGreaterThan(0)
    expect(snapshot.project.backendBindings[0]?.capabilities).toContain(
      'symbol_overview',
    )
    expect(snapshot.project.backendBindings[0]?.capabilities).toContain(
      'diagnostics',
    )
    expect(snapshot.project.serena.openWebDashboard).toBe(false)
    expect(buildSerenaLaunchArgs(snapshot.project.serena, directory)).toContain(
      '--open-web-dashboard',
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

  it('migrates legacy Serena args into structured config', async () => {
    const directory = await workspace()
    const store = new ProjectMetadataStore()
    const baseline = await store.get(directory)
    const filePath = path.join(directory, '.zch', 'project-model.json')
    const legacyProject = {
      ...baseline.project,
      serena: {
        id: 'serena',
        enabled: true,
        command: 'serena',
        args: [
          'start-mcp-server',
          '--context',
          'desktop-app',
          '--project-from-cwd',
          '--language-backend',
          'LSP',
          '--open-web-dashboard',
          'true',
          '--tool-timeout',
          '42',
          '--unknown-flag',
        ],
        startupTimeoutMs: 15_000,
        toolTimeoutMs: 30_000,
        languages: ['typescript'],
      },
    }
    await writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          project: legacyProject,
        },
        null,
        2,
      ),
      'utf8',
    )

    const snapshot = await store.get(directory)

    expect(snapshot.project.serena).toMatchObject({
      context: 'desktop-app',
      projectMode: 'projectFromCwd',
      languageBackend: 'LSP',
      openWebDashboard: true,
      toolTimeoutMs: 42_000,
      extraArgs: ['--unknown-flag'],
    })
    expect(snapshot.project.serena).not.toHaveProperty('args')
  })

  it('drops old default args and adds the hidden dashboard default', async () => {
    const directory = await workspace()
    const store = new ProjectMetadataStore()
    const baseline = await store.get(directory)
    const filePath = path.join(directory, '.zch', 'project-model.json')
    await writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          project: {
            ...baseline.project,
            serena: {
              id: 'serena',
              enabled: false,
              command: 'serena',
              args: [
                'start-mcp-server',
                '--context',
                'ide-assistant',
                '--project',
                '${workspace}',
              ],
              startupTimeoutMs: 15_000,
              toolTimeoutMs: 30_000,
              languages: ['typescript'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const snapshot = await store.get(directory)
    const launchArgs = buildSerenaLaunchArgs(snapshot.project.serena, directory)

    expect(snapshot.project.serena.context).toBe('ide-assistant')
    expect(snapshot.project.serena.projectMode).toBe('workspacePath')
    expect(snapshot.project.serena.openWebDashboard).toBe(false)
    expect(snapshot.project.serena.extraArgs).toEqual([])
    expect(snapshot.project.serena).not.toHaveProperty('args')
    expect(launchArgs).toEqual(
      expect.arrayContaining(['--open-web-dashboard', 'false']),
    )
  })
})
