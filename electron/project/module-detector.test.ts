import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectModuleDetector } from './module-detector'

const directories: string[] = []

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-detect-'))
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

describe('ProjectModuleDetector', () => {
  it('detects multi-module workspaces from manifests', async () => {
    const directory = await workspace()
    await mkdir(path.join(directory, 'frontend', 'src'), { recursive: true })
    await mkdir(path.join(directory, 'backend'), { recursive: true })
    await writeFile(path.join(directory, 'frontend', 'package.json'), '{}')
    await writeFile(path.join(directory, 'frontend', 'tsconfig.json'), '{}')
    await writeFile(path.join(directory, 'backend', 'go.mod'), 'module example')

    const modules = await new ProjectModuleDetector().detect(directory)

    expect(modules.map((module) => module.root)).toEqual(
      expect.arrayContaining(['frontend', 'backend']),
    )
    expect(
      modules.find((module) => module.root === 'frontend')?.languages,
    ).toEqual(expect.arrayContaining(['typescript', 'javascript']))
    expect(
      modules.find((module) => module.root === 'backend')?.languages,
    ).toEqual(['go'])
  })

  it('returns no modules when no manifests are present', async () => {
    const directory = await workspace()
    await mkdir(path.join(directory, 'src'), { recursive: true })

    await expect(
      new ProjectModuleDetector().detect(directory),
    ).resolves.toEqual([])
  })
})
