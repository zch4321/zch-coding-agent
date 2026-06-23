import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionContext } from './types'
import { SkillsManager } from '../skills/manager'
import { registerSkillTools } from './skill-tools'
import { ToolRegistry } from './tool-registry'

describe('read_skill tool', () => {
  it('rejects path-like names before reading and serves enabled instructions from memory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-tool-'))
    await mkdir(directory, { recursive: true })
    const filePath = path.join(directory, 'testing.md')
    await writeFile(
      filePath,
      '---\nname: testing\ndescription: Test instructions\n---\nUse the test workflow.\n',
    )
    const manager = new SkillsManager(directory)
    await manager.initialize()
    await manager.setEnabled('testing', true)
    const registry = new ToolRegistry()
    registerSkillTools(registry, manager)
    const definition = registry.get('read_skill')!
    const read = vi.spyOn(manager, 'read')

    expect(
      registry.validateArgs(definition, { name: '../testing' }),
    ).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()

    await unlink(filePath)
    const result = await definition.execute(
      { name: 'testing' },
      {} as ToolExecutionContext,
    )
    expect(result).toMatchObject({
      status: 'ok',
      content: {
        name: 'testing',
        body: 'Use the test workflow.\n',
        source: 'manual',
      },
    })
  })
})
