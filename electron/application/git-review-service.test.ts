import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitReviewService } from './git-review-service'

const execFileAsync = promisify(execFile)

async function git(workspace: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  })
  return result.stdout
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-review-service-'))
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Git Review Test')
  await git(root, 'config', 'user.email', 'git-review@example.test')
  await writeFile(path.join(root, 'tracked.txt'), 'base\n', 'utf8')
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'base')
  return root
}

describe('GitReviewService', () => {
  it('reports a non-Git Project without inventing Diff state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'git-review-non-repo-'))
    try {
      await expect(new GitReviewService().getStatus(root)).resolves.toEqual({
        repository: false,
        workspace: root,
        detached: false,
        unborn: false,
        baseRefs: [],
        entries: [],
        truncated: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads live tracked, staged, untracked, and binary Git state', async () => {
    const root = await repository()
    const service = new GitReviewService()
    try {
      await writeFile(path.join(root, 'tracked.txt'), 'base\nworking\n', 'utf8')
      await writeFile(path.join(root, 'untracked.txt'), 'new\n', 'utf8')
      await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]))

      const status = await service.getStatus(root)
      expect(status).toMatchObject({
        repository: true,
        topLevel: await realpath(root),
        headRef: 'main',
        detached: false,
        unborn: false,
      })
      expect(status.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'tracked.txt',
            worktreeStatus: 'M',
          }),
          expect.objectContaining({
            path: 'untracked.txt',
            kind: 'untracked',
          }),
        ]),
      )

      const headDiff = await service.getDiff({
        workspace: root,
        mode: 'head',
        path: 'tracked.txt',
      })
      expect(headDiff.content).toContain('+working')
      expect(headDiff.truncated).toBe(false)

      const binaryDiff = await service.getDiff({
        workspace: root,
        mode: 'head',
        path: 'binary.bin',
      })
      expect(binaryDiff.binary).toBe(true)
      expect(binaryDiff.content).not.toContain('GIT binary patch')

      await git(root, 'add', 'tracked.txt')
      const staged = await service.getDiff({
        workspace: root,
        mode: 'staged',
        path: 'tracked.txt',
      })
      expect(staged.content).toContain('+working')
      const unstaged = await service.getDiff({
        workspace: root,
        mode: 'unstaged',
        path: 'tracked.txt',
      })
      expect(unstaged.content).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves merge base before comparing the current working tree', async () => {
    const root = await repository()
    const service = new GitReviewService()
    try {
      await git(root, 'switch', '-c', 'feature/review')
      await writeFile(
        path.join(root, 'tracked.txt'),
        'feature commit\n',
        'utf8',
      )
      await git(root, 'add', 'tracked.txt')
      await git(root, 'commit', '-m', 'feature')
      await writeFile(
        path.join(root, 'tracked.txt'),
        'feature commit\nworking tree\n',
        'utf8',
      )

      const result = await service.getDiff({
        workspace: root,
        mode: 'merge_base',
        baseRef: 'main',
        path: 'tracked.txt',
      })

      expect(result.baseRef).toBe('main')
      expect(result.baseOid).toMatch(/^[a-f0-9]{40}$/u)
      expect(result.content).toContain('+feature commit')
      expect(result.content).toContain('+working tree')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves both paths for a staged rename', async () => {
    const root = await repository()
    const service = new GitReviewService()
    try {
      await git(root, 'mv', 'tracked.txt', 'renamed.txt')

      const status = await service.getStatus(root)

      expect(status.entries).toContainEqual(
        expect.objectContaining({
          path: 'renamed.txt',
          originalPath: 'tracked.txt',
          indexStatus: 'R',
          worktreeStatus: ' ',
          kind: 'renamed',
        }),
      )
      const diff = await service.getDiff({
        workspace: root,
        mode: 'staged',
        path: 'renamed.txt',
      })
      expect(diff.content).toContain('+++ b/renamed.txt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports unborn and detached HEAD without inventing a branch baseline', async () => {
    const unbornRoot = await mkdtemp(
      path.join(os.tmpdir(), 'git-review-unborn-'),
    )
    const service = new GitReviewService()
    try {
      await git(unbornRoot, 'init', '-b', 'main')
      await writeFile(path.join(unbornRoot, 'new.txt'), 'new file\n', 'utf8')
      await git(unbornRoot, 'add', 'new.txt')

      const unborn = await service.getStatus(unbornRoot)
      expect(unborn).toMatchObject({
        repository: true,
        headRef: 'main',
        detached: false,
        unborn: true,
      })
      expect(unborn).not.toHaveProperty('headOid')
      await expect(
        service.getDiff({ workspace: unbornRoot, mode: 'head' }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(
        service.getDiff({
          workspace: unbornRoot,
          mode: 'staged',
          path: 'new.txt',
        }),
      ).resolves.toMatchObject({
        content: expect.stringContaining('+new file'),
      })
    } finally {
      await rm(unbornRoot, { recursive: true, force: true })
    }

    const detachedRoot = await repository()
    try {
      await git(detachedRoot, 'checkout', '--detach')
      const detached = await service.getStatus(detachedRoot)
      expect(detached).toMatchObject({
        repository: true,
        detached: true,
        unborn: false,
      })
      expect(detached).not.toHaveProperty('headRef')
      expect(detached.headOid).toMatch(/^[a-f0-9]{40}$/u)
    } finally {
      await rm(detachedRoot, { recursive: true, force: true })
    }
  })

  it('limits status and diff queries to a Project subdirectory', async () => {
    const root = await repository()
    const project = path.join(root, 'packages', 'app')
    const service = new GitReviewService()
    try {
      await mkdir(project, { recursive: true })
      await writeFile(path.join(project, 'inside.txt'), 'inside base\n', 'utf8')
      await writeFile(path.join(root, 'outside.txt'), 'outside base\n', 'utf8')
      await git(root, 'add', '.')
      await git(root, 'commit', '-m', 'nested project')
      await writeFile(
        path.join(project, 'inside.txt'),
        'inside changed\n',
        'utf8',
      )
      await writeFile(
        path.join(root, 'outside.txt'),
        'outside changed\n',
        'utf8',
      )

      const status = await service.getStatus(project)
      expect(status.entries.map((entry) => entry.path)).toEqual([
        'packages/app/inside.txt',
      ])
      const diff = await service.getDiff({ workspace: project, mode: 'head' })
      expect(diff.content).toContain('inside changed')
      expect(diff.content).not.toContain('outside changed')
      await expect(
        service.getDiff({
          workspace: project,
          mode: 'head',
          path: 'outside.txt',
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
