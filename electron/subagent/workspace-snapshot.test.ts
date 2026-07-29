import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkspaceSnapshotError,
  WorkspaceSnapshotService,
} from './workspace-snapshot'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-snapshot-test-'))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    },
  }).then(({ stdout }) => stdout)
}

async function gitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await git(workspace, ['init', '--quiet'])
  await git(workspace, ['config', 'user.name', 'agent'])
  await git(workspace, ['config', 'user.email', 'agent@example.com'])
  await writeFile(path.join(workspace, 'README.md'), 'initial\n')
  await git(workspace, ['add', 'README.md'])
  await git(workspace, ['commit', '--quiet', '-m', 'initial'])
  return workspace
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('WorkspaceSnapshotService', () => {
  it('copies a non-Git workspace, skips generated directories, and cleans it', async () => {
    const root = await temporaryRoot()
    const workspace = path.join(root, 'workspace')
    const runtime = path.join(root, 'runtime')
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await mkdir(path.join(workspace, 'node_modules', 'pkg'), {
      recursive: true,
    })
    await writeFile(path.join(workspace, 'src', 'index.ts'), 'export {}\n')
    await writeFile(
      path.join(workspace, 'node_modules', 'pkg', 'index.js'),
      'generated\n',
    )
    const service = new WorkspaceSnapshotService(runtime)
    await service.initialize()

    const snapshot = await service.create(
      workspace,
      new AbortController().signal,
    )
    expect(snapshot.gitAvailable).toBe(false)
    expect(snapshot.identity).toMatchObject({
      schemaVersion: 1,
      fileCount: 1,
      skippedDirectories: ['node_modules'],
    })
    await expect(
      readFile(path.join(snapshot.workspace, 'src', 'index.ts'), 'utf8'),
    ).resolves.toBe('export {}\n')
    await expect(
      access(path.join(snapshot.workspace, 'node_modules')),
    ).rejects.toBeDefined()

    const snapshotRoot = path.dirname(snapshot.workspace)
    await snapshot.dispose()
    await expect(access(snapshotRoot)).rejects.toBeDefined()
  })

  it('reconstructs committed, staged, unstaged, and untracked Git state', async () => {
    const root = await temporaryRoot()
    const workspace = await gitWorkspace(root)
    await writeFile(path.join(workspace, 'README.md'), 'unstaged\n')
    await writeFile(path.join(workspace, 'staged.txt'), 'staged\n')
    await git(workspace, ['add', 'staged.txt'])
    await writeFile(path.join(workspace, 'untracked.txt'), 'untracked\n')
    const service = new WorkspaceSnapshotService(path.join(root, 'runtime'))
    await service.initialize()

    const snapshot = await service.create(
      workspace,
      new AbortController().signal,
    )
    try {
      expect(snapshot.gitAvailable).toBe(true)
      const status = await git(snapshot.workspace, ['status', '--short'])
      expect(status).toContain(' M README.md')
      expect(status).toContain('A  staged.txt')
      expect(status).toContain('?? untracked.txt')
      await expect(
        git(snapshot.workspace, ['log', '-1', '--format=%s']),
      ).resolves.toContain('initial')
      await expect(
        git(snapshot.workspace, ['diff', '--', 'README.md']),
      ).resolves.toContain('+unstaged')
      await expect(
        git(snapshot.workspace, ['diff', '--cached', '--', 'staged.txt']),
      ).resolves.toContain('+staged')

      await writeFile(path.join(workspace, 'README.md'), 'changed later\n')
      await expect(
        readFile(path.join(snapshot.workspace, 'README.md'), 'utf8'),
      ).resolves.toBe('unstaged\n')
      await expect(git(snapshot.workspace, ['remote'])).resolves.toBe('')
    } finally {
      await snapshot.dispose()
    }
  }, 15_000)

  it('does not expose Git tools for a workspace nested inside a larger repository', async () => {
    const root = await temporaryRoot()
    const repository = await gitWorkspace(root)
    const workspace = path.join(repository, 'packages', 'child')
    await mkdir(workspace, { recursive: true })
    await writeFile(
      path.join(workspace, 'index.ts'),
      'export const child = true\n',
    )
    const service = new WorkspaceSnapshotService(path.join(root, 'runtime'))
    await service.initialize()

    const snapshot = await service.create(
      workspace,
      new AbortController().signal,
    )
    try {
      expect(snapshot.gitAvailable).toBe(false)
      await expect(
        access(path.join(snapshot.workspace, '.git')),
      ).rejects.toBeDefined()
    } finally {
      await snapshot.dispose()
    }
  })

  it('rejects symlinks that escape the workspace', async () => {
    const root = await temporaryRoot()
    const workspace = path.join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(root, 'secret.txt'), 'outside\n')
    await symlink('../secret.txt', path.join(workspace, 'escape.txt'))
    const service = new WorkspaceSnapshotService(path.join(root, 'runtime'))
    await service.initialize()

    await expect(
      service.create(workspace, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_UNSAFE_FILE',
    } satisfies Partial<WorkspaceSnapshotError>)
  })

  it('preserves relative symlinks that resolve inside the workspace', async () => {
    const root = await temporaryRoot()
    const workspace = path.join(root, 'workspace')
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await writeFile(path.join(workspace, 'src', 'target.txt'), 'inside\n')
    await symlink('src/target.txt', path.join(workspace, 'link.txt'))
    const service = new WorkspaceSnapshotService(path.join(root, 'runtime'))
    await service.initialize()

    const snapshot = await service.create(
      workspace,
      new AbortController().signal,
    )
    try {
      await expect(
        readFile(path.join(snapshot.workspace, 'link.txt'), 'utf8'),
      ).resolves.toBe('inside\n')
    } finally {
      await snapshot.dispose()
    }
  })

  it('rejects a sparse file that exceeds the one-GiB snapshot limit', async () => {
    const root = await temporaryRoot()
    const workspace = path.join(root, 'workspace')
    const oversized = path.join(workspace, 'oversized.bin')
    await mkdir(workspace)
    await writeFile(oversized, '')
    await truncate(oversized, 1_073_741_825)
    const service = new WorkspaceSnapshotService(path.join(root, 'runtime'))
    await service.initialize()

    await expect(
      service.create(workspace, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SNAPSHOT_LIMIT',
    } satisfies Partial<WorkspaceSnapshotError>)
  })

  it('removes abandoned snapshot directories during startup', async () => {
    const root = await temporaryRoot()
    const runtime = path.join(root, 'runtime')
    const stale = path.join(runtime, 'subagent-snapshots', 'snapshot-stale')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'leftover'), 'stale')
    const service = new WorkspaceSnapshotService(runtime)

    await service.initialize()

    await expect(readdir(path.dirname(stale))).resolves.toEqual([])
  })
})
