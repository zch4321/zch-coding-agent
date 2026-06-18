import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathGuard, PathGuardError } from './path-guard'

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-path-'))
  await writeFile(path.join(root, 'README.md'), '# Test\n')
  await mkdir(path.join(root, 'src'))
  await writeFile(
    path.join(root, 'src', 'index.ts'),
    'export const value = 1\n',
  )
  return root
}

describe('PathGuard', () => {
  it('allows existing files inside the workspace', async () => {
    const root = await workspace()
    const guard = await PathGuard.create(root)
    const result = await guard.readFileBounded('README.md', 1_000)

    expect(result.path).toBe('README.md')
    expect(result.content).toContain('# Test')
    expect(result.truncated).toBe(false)
  })

  it('rejects relative and absolute escapes', async () => {
    const root = await workspace()
    const outside = path.join(path.dirname(root), 'outside.txt')
    await writeFile(outside, 'secret')
    const guard = await PathGuard.create(root)

    await expect(guard.resolveExisting('../outside.txt')).rejects.toMatchObject(
      {
        code: 'PATH_OUTSIDE_WORKSPACE',
      } satisfies Partial<PathGuardError>,
    )
    await expect(guard.resolveExisting(outside)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    } satisfies Partial<PathGuardError>)
  })

  it('rejects symlinks that resolve outside the workspace when supported', async () => {
    const root = await workspace()
    const outside = path.join(path.dirname(root), 'linked-secret.txt')
    await writeFile(outside, 'secret')
    const link = path.join(root, 'link.txt')

    try {
      await symlink(outside, link)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return
      }

      throw error
    }

    const guard = await PathGuard.create(root)
    await expect(guard.resolveExisting('link.txt')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    } satisfies Partial<PathGuardError>)
  })
})
