import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readFileContentState,
  restoreFileContent,
  sha256,
} from './file-change-filesystem'

let root: string
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zch-file-change-fs-'))
  workspace = path.join(root, 'workspace')
  await mkdir(workspace)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('FileChange filesystem boundaries', () => {
  it('rejects symbolic-link and non-file targets', async () => {
    const targetDirectory = path.join(root, 'target-directory')
    await mkdir(targetDirectory)
    await symlink(
      targetDirectory,
      path.join(workspace, 'linked-target'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await mkdir(path.join(workspace, 'plain-directory'))

    await expect(
      readFileContentState(workspace, 'linked-target'),
    ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
    await expect(
      readFileContentState(workspace, 'plain-directory'),
    ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
  })

  it('rejects a target reached through a parent link outside the workspace', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'escaped.txt'), 'outside content')
    await symlink(
      outside,
      path.join(workspace, 'escaped-parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(
      readFileContentState(workspace, 'escaped-parent/escaped.txt'),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
  })

  it('removes its temporary file and preserves the target after a restore failure', async () => {
    const target = path.join(workspace, 'target.txt')
    await writeFile(target, 'agent content')

    await expect(
      restoreFileContent({
        workspace,
        path: 'target.txt',
        beforeExists: true,
        beforeContent: 'original content',
        beforeMode: -1,
        afterExists: true,
        afterHash: sha256('agent content'),
      }),
    ).rejects.toThrow()

    expect(await readFile(target, 'utf8')).toBe('agent content')
    expect(
      (await readdir(workspace)).filter(
        (name) => name.startsWith('.target.txt.') && name.endsWith('.revert'),
      ),
    ).toEqual([])
  })
})
