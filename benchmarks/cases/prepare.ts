import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LoadedBenchmarkCase } from './contracts'
import { archiveTreeSha256 } from './hash'
import { BenchmarkCaseValidationError, loadCaseArchive } from './loader'
import { runGit } from './process'

const FORBIDDEN_AGENT_PATH_PARTS = [
  'gold',
  'grader',
  'hidden',
  'mutant',
  'oracle',
  'pass_to_pass',
  'fail_to_pass',
  'test_patch',
]
const FORBIDDEN_AGENT_CONTENT = [
  'oraclePatch',
  'expectedFailedGroups',
  'fail_to_pass',
  'pass_to_pass',
  'privateSpecSha256',
]

export interface PreparedBenchmarkWorkspace {
  workspace: string
  baselineCommit: string
  treeSha256: string
  files: string[]
}

/** Prepares benchmark workspace. */
export async function prepareBenchmarkWorkspace(input: {
  loadedCase: LoadedBenchmarkCase
  destination: string
}): Promise<PreparedBenchmarkWorkspace> {
  const archive = await loadCaseArchive(input.loadedCase)
  await ensureEmptyDirectory(input.destination)
  for (const file of archive.files) {
    const destination = containedPath(input.destination, file.path)
    await ensureParentDirectory(destination, input.destination)
    const handle = await open(
      destination,
      'wx',
      file.executable ? 0o755 : 0o644,
    )
    try {
      await handle.writeFile(file.content, 'utf8')
    } finally {
      await handle.close()
    }
  }
  const treeSha256 = archiveTreeSha256(archive)
  if (treeSha256 !== input.loadedCase.identity.treeSha256) {
    throw new BenchmarkCaseValidationError('Prepared tree checksum mismatch')
  }
  await runGit({
    workspace: input.destination,
    args: ['init', '--initial-branch=benchmark'],
  })
  await runGit({
    workspace: input.destination,
    args: ['config', 'core.autocrlf', 'false'],
  })
  await runGit({
    workspace: input.destination,
    args: ['-c', 'core.autocrlf=false', 'add', '--all'],
  })
  for (const file of archive.files.filter(
    (candidate) => candidate.executable,
  )) {
    await runGit({
      workspace: input.destination,
      args: ['update-index', '--chmod=+x', '--', file.path],
    })
  }
  await runGit({
    workspace: input.destination,
    args: [
      '-c',
      'user.name=Benchmark Fixture',
      '-c',
      'user.email=benchmark@example.invalid',
      'commit',
      '--no-gpg-sign',
      '-m',
      'benchmark baseline',
    ],
    environment: {
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  })
  await runGit({
    workspace: input.destination,
    args: ['config', 'gc.auto', '0'],
  })
  await Promise.all([
    rm(path.join(input.destination, '.git', 'logs'), {
      recursive: true,
      force: true,
    }),
    rm(path.join(input.destination, '.git', 'hooks'), {
      recursive: true,
      force: true,
    }),
    rm(path.join(input.destination, '.git', 'refs', 'remotes'), {
      recursive: true,
      force: true,
    }),
    rm(path.join(input.destination, '.git', 'refs', 'tags'), {
      recursive: true,
      force: true,
    }),
  ])
  const baselineCommit = (
    await runGit({ workspace: input.destination, args: ['rev-parse', 'HEAD'] })
  ).stdout.trim()
  const files = await scanAgentVisibleWorkspace({
    workspace: input.destination,
    expectedFiles: archive.files.map((file) => file.path),
  })
  return { workspace: input.destination, baselineCommit, treeSha256, files }
}

/** Scans agent visible workspace. */
export async function scanAgentVisibleWorkspace(input: {
  workspace: string
  expectedFiles: string[]
}): Promise<string[]> {
  const files = await listWorkspaceFiles(input.workspace)
  const expected = [...input.expectedFiles].sort()
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new BenchmarkCaseValidationError(
      'Prepared workspace does not match the archive file list',
    )
  }
  for (const relative of files) {
    const lowered = relative.toLowerCase()
    if (FORBIDDEN_AGENT_PATH_PARTS.some((part) => lowered.includes(part))) {
      throw new BenchmarkCaseValidationError(
        `Agent-visible workspace contains a private path: ${relative}`,
      )
    }
    const absolute = containedPath(input.workspace, relative)
    const fileStat = await stat(absolute)
    if (fileStat.size > 2 * 1024 * 1024) continue
    const content = await readFile(absolute, 'utf8')
    if (FORBIDDEN_AGENT_CONTENT.some((token) => content.includes(token))) {
      throw new BenchmarkCaseValidationError(
        `Agent-visible workspace contains evaluator metadata: ${relative}`,
      )
    }
  }
  const [remotes, tags, reflog, unreachable] = await Promise.all([
    runGit({
      workspace: input.workspace,
      args: ['remote'],
      allowFailure: true,
    }),
    runGit({ workspace: input.workspace, args: ['tag'], allowFailure: true }),
    runGit({
      workspace: input.workspace,
      args: ['reflog', 'show', '--all'],
      allowFailure: true,
    }),
    runGit({
      workspace: input.workspace,
      args: ['fsck', '--unreachable', '--no-reflogs'],
      allowFailure: true,
    }),
  ])
  if (
    remotes.stdout.trim() ||
    tags.stdout.trim() ||
    reflog.stdout.trim() ||
    unreachable.stdout.trim()
  ) {
    throw new BenchmarkCaseValidationError(
      'Prepared workspace retains remote, tag, reflog, or unreachable history',
    )
  }
  return files
}

async function ensureEmptyDirectory(destination: string): Promise<void> {
  try {
    const existing = await readdir(destination)
    if (existing.length > 0) {
      throw new BenchmarkCaseValidationError(
        'Benchmark workspace destination must be empty',
      )
    }
  } catch (error) {
    if (error instanceof BenchmarkCaseValidationError) throw error
    await mkdir(destination, { recursive: true })
  }
}

async function ensureParentDirectory(
  filePath: string,
  workspace: string,
): Promise<void> {
  const parent = path.dirname(filePath)
  const relation = path.relative(path.resolve(workspace), parent)
  if (
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new BenchmarkCaseValidationError('Archive parent escapes workspace')
  }
  await mkdir(parent, { recursive: true })
}

function containedPath(workspace: string, relative: string): string {
  const normalized = relative.replaceAll('\\', '/')
  const candidate = path.resolve(workspace, normalized)
  const relation = path.relative(path.resolve(workspace), candidate)
  if (
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new BenchmarkCaseValidationError(`Unsafe archive path: ${relative}`)
  }
  return candidate
}

async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  const output: string[] = []
  const pending = ['.']
  while (pending.length > 0) {
    const relative = pending.pop()!
    const absolute = path.resolve(workspace, relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (relative === '.' && entry.name === '.git') continue
      if (entry.isSymbolicLink()) {
        throw new BenchmarkCaseValidationError(
          `Archive produced a symbolic link: ${entry.name}`,
        )
      }
      const nested = relative === '.' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) pending.push(nested)
      else if (entry.isFile()) output.push(nested.replaceAll('\\', '/'))
    }
  }
  return output.sort()
}
