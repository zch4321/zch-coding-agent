import { spawn } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { JsonValue } from '../../shared/json'
import { createCommandEnvironment } from '../process/run'
import {
  WorkspaceSnapshotError,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotIdentity,
} from './workspace-snapshot-types'
import { SnapshotDeadline } from './workspace-snapshot-deadline'

export {
  WorkspaceSnapshotError,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotIdentity,
} from './workspace-snapshot-types'

const MAX_FILES = 100_000
const MAX_BYTES = 1_073_741_824
const MAX_GIT_METADATA_BYTES = 64 * 1_024 * 1_024
const COPY_BUFFER_BYTES = 256 * 1_024
const GENERATED_DIRECTORIES = new Set([
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])

type ManifestEntry =
  | { type: 'directory'; path: string; mode: number }
  | {
      type: 'file'
      path: string
      mode: number
      size: number
      sha256: string
    }
  | { type: 'symlink'; path: string; target: string }

interface GitSourceState {
  head?: string
  symbolicHead?: string
  refsHash: string
  indexHash: string
  statusHash: string
  trackedDirectories: Set<string>
}

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value
  return normalize(path.resolve(left)) === normalize(path.resolve(right))
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(filePath: string, deadline: SnapshotDeadline) {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(filePath, {
    highWaterMark: COPY_BUFFER_BYTES,
  })
  const abort = () => stream.destroy(deadline.signal.reason as Error)
  deadline.signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) {
      deadline.check()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BYTES) {
        throw new WorkspaceSnapshotError(
          'SNAPSHOT_LIMIT',
          'Git index exceeded the snapshot byte limit',
        )
      }
      hash.update(buffer)
    }
  } finally {
    deadline.signal.removeEventListener('abort', abort)
  }
  return hash.digest('hex')
}

interface GitCommandResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

function gitEnvironment(hooksDirectory: string): NodeJS.ProcessEnv {
  return {
    ...createCommandEnvironment(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(hooksDirectory, 'global.gitconfig'),
    NO_COLOR: '1',
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  deadline: SnapshotDeadline,
  hooksDirectory: string,
  options: { allowFailure?: boolean; maxOutputBytes?: number } = {},
): Promise<GitCommandResult> {
  deadline.check()
  const result = await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'color.ui=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${hooksDirectory}`,
        ...args,
      ],
      {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitEnvironment(hooksDirectory),
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const maxOutput = options.maxOutputBytes ?? MAX_GIT_METADATA_BYTES
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(
        new WorkspaceSnapshotError(
          'SNAPSHOT_TIMEOUT',
          'Git snapshot command exceeded the snapshot deadline',
        ),
      )
    }, deadline.remainingMs())
    const abort = () => fail(deadline.signal.reason)
    deadline.signal.addEventListener('abort', abort, { once: true })
    child.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutput) {
        fail(
          new WorkspaceSnapshotError(
            'SNAPSHOT_LIMIT',
            'Git metadata exceeded the snapshot byte limit',
          ),
        )
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 1_048_576) stderr.push(chunk)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').slice(0, 8_192),
      })
    })
    child.once('close', () => {
      clearTimeout(timer)
      deadline.signal.removeEventListener('abort', abort)
    })
  })
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new WorkspaceSnapshotError(
      'SNAPSHOT_GIT_FAILED',
      `Git snapshot command failed: ${result.stderr || `exit ${result.exitCode}`}`,
    )
  }
  return result
}

async function runGitToFile(
  cwd: string,
  args: readonly string[],
  outputPath: string,
  deadline: SnapshotDeadline,
  hooksDirectory: string,
): Promise<number> {
  deadline.check()
  const output = await open(outputPath, 'wx', 0o600)
  let bytes = 0
  try {
    const result = await new Promise<{ exitCode: number; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          'git',
          [
            '--no-pager',
            '--no-optional-locks',
            '-c',
            'color.ui=false',
            '-c',
            'core.fsmonitor=false',
            '-c',
            `core.hooksPath=${hooksDirectory}`,
            ...args,
          ],
          {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: gitEnvironment(hooksDirectory),
          },
        )
        const stderr: Buffer[] = []
        let stderrBytes = 0
        let tail = Promise.resolve()
        let settled = false
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(error)
        }
        const timer = setTimeout(() => {
          fail(
            new WorkspaceSnapshotError(
              'SNAPSHOT_TIMEOUT',
              'Git snapshot command exceeded the snapshot deadline',
            ),
          )
        }, deadline.remainingMs())
        const abort = () => fail(deadline.signal.reason)
        deadline.signal.addEventListener('abort', abort, { once: true })
        child.once('error', fail)
        child.stdout.on('data', (chunk: Buffer) => {
          child.stdout.pause()
          bytes += chunk.length
          if (bytes > MAX_BYTES) {
            fail(
              new WorkspaceSnapshotError(
                'SNAPSHOT_LIMIT',
                'Git snapshot data exceeded 1 GiB',
              ),
            )
            return
          }
          tail = tail
            .then(async () => {
              await output.write(chunk)
              child.stdout.resume()
            })
            .catch(fail)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length
          if (stderrBytes <= 1_048_576) stderr.push(chunk)
        })
        child.once('close', (exitCode) => {
          void tail.then(() => {
            if (settled) return
            settled = true
            resolve({
              exitCode: exitCode ?? -1,
              stderr: Buffer.concat(stderr).toString('utf8').slice(0, 8_192),
            })
          }, fail)
        })
        child.once('close', () => {
          clearTimeout(timer)
          deadline.signal.removeEventListener('abort', abort)
        })
      },
    )
    if (result.exitCode !== 0) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_GIT_FAILED',
        `Git snapshot command failed: ${result.stderr || `exit ${result.exitCode}`}`,
      )
    }
    return bytes
  } finally {
    await output.close()
  }
}

async function gitText(
  cwd: string,
  args: readonly string[],
  deadline: SnapshotDeadline,
  hooksDirectory: string,
): Promise<string | undefined> {
  const result = await runGit(cwd, args, deadline, hooksDirectory, {
    allowFailure: true,
    maxOutputBytes: 1_048_576,
  })
  return result.exitCode === 0
    ? result.stdout.toString('utf8').trim() || undefined
    : undefined
}

async function gitIndexHash(
  workspace: string,
  deadline: SnapshotDeadline,
  hooksDirectory: string,
): Promise<string> {
  const indexPath = await gitText(
    workspace,
    ['rev-parse', '--git-path', 'index'],
    deadline,
    hooksDirectory,
  )
  if (!indexPath) return sha256('missing-index')
  const resolved = path.isAbsolute(indexPath)
    ? indexPath
    : path.resolve(workspace, indexPath)
  try {
    return await hashFile(resolved, deadline)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return sha256('missing-index')
    }
    throw error
  }
}

function trackedDirectories(paths: readonly string[]): Set<string> {
  const directories = new Set<string>()
  for (const trackedPath of paths) {
    const segments = trackedPath.split('/')
    segments.pop()
    while (segments.length > 0) {
      directories.add(segments.join('/'))
      segments.pop()
    }
  }
  return directories
}

async function captureGitState(
  workspace: string,
  deadline: SnapshotDeadline,
  hooksDirectory: string,
  includeTracked: boolean,
): Promise<GitSourceState> {
  const [head, symbolicHead, refs, statusResult, indexHash, trackedResult] =
    await Promise.all([
      gitText(
        workspace,
        ['rev-parse', '--verify', 'HEAD'],
        deadline,
        hooksDirectory,
      ),
      gitText(
        workspace,
        ['symbolic-ref', '-q', 'HEAD'],
        deadline,
        hooksDirectory,
      ),
      runGit(
        workspace,
        ['for-each-ref', '--format=%(refname)%00%(objectname)'],
        deadline,
        hooksDirectory,
      ),
      runGit(
        workspace,
        [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
        ],
        deadline,
        hooksDirectory,
      ),
      gitIndexHash(workspace, deadline, hooksDirectory),
      includeTracked
        ? runGit(
            workspace,
            ['ls-files', '-z', '--cached'],
            deadline,
            hooksDirectory,
          )
        : Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: '' }),
    ])
  const tracked = trackedResult.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((value) => value.split(path.sep).join('/'))
  return {
    ...(head ? { head } : {}),
    ...(symbolicHead ? { symbolicHead } : {}),
    refsHash: sha256(refs.stdout),
    indexHash,
    statusHash: sha256(statusResult.stdout),
    trackedDirectories: trackedDirectories(tracked),
  }
}

function gitIdentity(state: GitSourceState) {
  return {
    ...(state.head ? { head: state.head } : {}),
    ...(state.symbolicHead ? { symbolicHead: state.symbolicHead } : {}),
    refsHash: state.refsHash,
    indexHash: state.indexHash,
    statusHash: state.statusHash,
  }
}

function sameGitState(left: GitSourceState, right: GitSourceState): boolean {
  return (
    JSON.stringify(gitIdentity(left)) === JSON.stringify(gitIdentity(right))
  )
}

interface CaptureResult {
  entries: ManifestEntry[]
  fileCount: number
  totalBytes: number
  skippedDirectories: string[]
}

function shouldSkipDirectory(
  relativePath: string,
  name: string,
  tracked: ReadonlySet<string>,
): boolean {
  if (name === '.git') return true
  return GENERATED_DIRECTORIES.has(name) && !tracked.has(portable(relativePath))
}

function sameOpenFile(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  right: typeof left,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function captureRegularFile(input: {
  sourcePath: string
  destinationPath?: string
  relativePath: string
  deadline: SnapshotDeadline
  remainingBytes: number
}): Promise<Extract<ManifestEntry, { type: 'file' }>> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const source = await open(input.sourcePath, constants.O_RDONLY | noFollow)
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await source.stat()
    if (!before.isFile()) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_UNSAFE_FILE',
        `Snapshot entry changed type: ${input.relativePath}`,
      )
    }
    if (before.size > input.remainingBytes) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_LIMIT',
        'Workspace snapshot exceeded 1 GiB',
      )
    }
    if (input.destinationPath) {
      destination = await open(input.destinationPath, 'wx', before.mode & 0o777)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (position < before.size) {
      input.deadline.check()
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      )
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (destination) await destination.write(chunk, 0, bytesRead, position)
      position += bytesRead
    }
    const after = await source.stat()
    if (position !== before.size || !sameOpenFile(before, after)) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_CHANGED',
        `Workspace file changed while copying: ${input.relativePath}`,
      )
    }
    return {
      type: 'file',
      path: portable(input.relativePath),
      mode: before.mode & 0o777,
      size: before.size,
      sha256: hash.digest('hex'),
    }
  } finally {
    await destination?.close()
    await source.close()
  }
}

async function captureWorkspace(input: {
  source: string
  destination?: string
  trackedDirectories: ReadonlySet<string>
  deadline: SnapshotDeadline
}): Promise<CaptureResult> {
  const entries: ManifestEntry[] = []
  const skippedDirectories: string[] = []
  let fileCount = 0
  let totalBytes = 0

  const visit = async (relativeDirectory: string): Promise<void> => {
    input.deadline.check()
    const sourceDirectory = path.join(input.source, relativeDirectory)
    const destinationDirectory = input.destination
      ? path.join(input.destination, relativeDirectory)
      : undefined
    if (destinationDirectory)
      await mkdir(destinationDirectory, { recursive: true })
    const names = (await readdir(sourceDirectory)).sort((left, right) =>
      left.localeCompare(right),
    )
    for (const name of names) {
      input.deadline.check()
      const relativePath = path.join(relativeDirectory, name)
      const sourcePath = path.join(input.source, relativePath)
      const destinationPath = input.destination
        ? path.join(input.destination, relativePath)
        : undefined
      const sourceStat = await lstat(sourcePath)
      if (sourceStat.isDirectory()) {
        if (shouldSkipDirectory(relativePath, name, input.trackedDirectories)) {
          if (name !== '.git') skippedDirectories.push(portable(relativePath))
          continue
        }
        entries.push({
          type: 'directory',
          path: portable(relativePath),
          mode: sourceStat.mode & 0o777,
        })
        await visit(relativePath)
        if (destinationPath) {
          await chmod(destinationPath, sourceStat.mode & 0o777).catch(
            () => undefined,
          )
        }
        continue
      }
      if (sourceStat.isSymbolicLink()) {
        fileCount += 1
        if (fileCount > MAX_FILES) {
          throw new WorkspaceSnapshotError(
            'SNAPSHOT_LIMIT',
            `Workspace snapshot exceeded ${MAX_FILES} files`,
          )
        }
        const target = await readlink(sourcePath)
        if (path.isAbsolute(target)) {
          throw new WorkspaceSnapshotError(
            'SNAPSHOT_UNSAFE_FILE',
            `Absolute symlink is not snapshot-safe: ${portable(relativePath)}`,
          )
        }
        const targetPath = await realpath(
          path.resolve(path.dirname(sourcePath), target),
        )
        if (!isInside(input.source, targetPath)) {
          throw new WorkspaceSnapshotError(
            'SNAPSHOT_UNSAFE_FILE',
            `Symlink points outside the workspace: ${portable(relativePath)}`,
          )
        }
        if (destinationPath) {
          const targetStat = await stat(targetPath)
          await symlink(
            target,
            destinationPath,
            process.platform === 'win32'
              ? targetStat.isDirectory()
                ? 'junction'
                : 'file'
              : undefined,
          )
        }
        entries.push({
          type: 'symlink',
          path: portable(relativePath),
          target,
        })
        continue
      }
      if (!sourceStat.isFile()) {
        throw new WorkspaceSnapshotError(
          'SNAPSHOT_UNSAFE_FILE',
          `Special filesystem entry is not supported: ${portable(relativePath)}`,
        )
      }
      fileCount += 1
      if (fileCount > MAX_FILES) {
        throw new WorkspaceSnapshotError(
          'SNAPSHOT_LIMIT',
          `Workspace snapshot exceeded ${MAX_FILES} files`,
        )
      }
      const entry = await captureRegularFile({
        sourcePath,
        ...(destinationPath ? { destinationPath } : {}),
        relativePath,
        deadline: input.deadline,
        remainingBytes: MAX_BYTES - totalBytes,
      })
      totalBytes += entry.size
      entries.push(entry)
    }
  }

  await visit('')
  return {
    entries,
    fileCount,
    totalBytes,
    skippedDirectories: skippedDirectories.sort(),
  }
}

function manifestHash(entries: readonly ManifestEntry[]): string {
  return sha256(JSON.stringify(entries))
}

function sameCapture(left: CaptureResult, right: CaptureResult): boolean {
  return (
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    JSON.stringify(left.skippedDirectories) ===
      JSON.stringify(right.skippedDirectories) &&
    manifestHash(left.entries) === manifestHash(right.entries)
  )
}

async function initializeGitSnapshot(input: {
  source: string
  destination: string
  temporaryRoot: string
  state: GitSourceState
  deadline: SnapshotDeadline
  hooksDirectory: string
}): Promise<void> {
  await runGit(
    input.destination,
    ['init', '--quiet'],
    input.deadline,
    input.hooksDirectory,
  )
  await runGit(
    input.destination,
    ['symbolic-ref', 'HEAD', 'refs/heads/__zch_snapshot__'],
    input.deadline,
    input.hooksDirectory,
  )

  if (input.state.head || input.state.refsHash !== sha256('')) {
    const bundlePath = path.join(input.temporaryRoot, 'source.bundle')
    const bundle = await runGit(
      input.source,
      ['bundle', 'create', bundlePath, '--all'],
      input.deadline,
      input.hooksDirectory,
      { allowFailure: true, maxOutputBytes: 1_048_576 },
    )
    if (bundle.exitCode === 0) {
      const bundleStat = await stat(bundlePath)
      if (bundleStat.size > MAX_BYTES) {
        throw new WorkspaceSnapshotError(
          'SNAPSHOT_LIMIT',
          'Git bundle exceeded 1 GiB',
        )
      }
      await runGit(
        input.destination,
        ['fetch', '--quiet', bundlePath, '+refs/*:refs/*'],
        input.deadline,
        input.hooksDirectory,
      )
      await rm(bundlePath, { force: true })
    } else if (input.state.head) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_GIT_FAILED',
        `Git bundle creation failed: ${bundle.stderr}`,
      )
    }
  }

  if (input.state.symbolicHead) {
    await runGit(
      input.destination,
      ['symbolic-ref', 'HEAD', input.state.symbolicHead],
      input.deadline,
      input.hooksDirectory,
    )
  } else if (input.state.head) {
    await runGit(
      input.destination,
      ['update-ref', '--no-deref', 'HEAD', input.state.head],
      input.deadline,
      input.hooksDirectory,
    )
  }

  await runGit(
    input.destination,
    input.state.head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'],
    input.deadline,
    input.hooksDirectory,
  )
  const patchPath = path.join(input.temporaryRoot, 'index.patch')
  const patchArgs = [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...(input.state.head ? ['HEAD'] : []),
    '--',
  ]
  const patchBytes = await runGitToFile(
    input.source,
    patchArgs,
    patchPath,
    input.deadline,
    input.hooksDirectory,
  )
  if (patchBytes > 0) {
    await runGit(
      input.destination,
      ['apply', '--cached', '--binary', '--whitespace=nowarn', patchPath],
      input.deadline,
      input.hooksDirectory,
      { maxOutputBytes: 1_048_576 },
    )
  }
  await rm(patchPath, { force: true })
  await runGit(
    input.destination,
    ['config', '--local', 'core.hooksPath', input.hooksDirectory],
    input.deadline,
    input.hooksDirectory,
  )
  await runGit(
    input.destination,
    ['config', '--local', 'core.fsmonitor', 'false'],
    input.deadline,
    input.hooksDirectory,
  )
  await runGit(
    input.destination,
    ['config', '--local', 'core.preloadIndex', 'false'],
    input.deadline,
    input.hooksDirectory,
  )
}

/** Creates and cleans bounded workspace/Git snapshots for Subagent executions. */
export class WorkspaceSnapshotService {
  readonly #directory: string

  constructor(runtimeDataDirectory: string) {
    this.#directory = path.resolve(runtimeDataDirectory, 'subagent-snapshots')
  }

  /** Removes abandoned snapshots from an earlier application process. */
  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.#directory)
    for (const entry of entries) {
      const target = path.resolve(this.#directory, entry)
      if (path.dirname(target) !== this.#directory) continue
      await rm(target, { recursive: true, force: true })
    }
  }

  /** Captures one stable source view or rejects if the source changes during capture. */
  async create(
    workspace: string,
    signal: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    const deadline = new SnapshotDeadline(signal)
    const source = await realpath(path.resolve(workspace))
    const sourceStat = await stat(source)
    if (!sourceStat.isDirectory()) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_UNSAFE_FILE',
        'Subagent workspace must be a directory',
      )
    }
    if (isInside(source, this.#directory)) {
      throw new WorkspaceSnapshotError(
        'SNAPSHOT_UNSAFE_FILE',
        'Snapshot storage must be outside the source workspace',
      )
    }

    const temporaryRoot = await mkdtemp(path.join(this.#directory, 'snapshot-'))
    const destination = path.join(temporaryRoot, 'workspace')
    const hooksDirectory = path.join(temporaryRoot, 'disabled-hooks')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await mkdir(hooksDirectory, { recursive: true, mode: 0o700 })
    let retained = false
    try {
      const gitRoot = await gitText(
        source,
        ['rev-parse', '--show-toplevel'],
        deadline,
        hooksDirectory,
      ).catch(() => undefined)
      const gitAvailable = Boolean(
        gitRoot && samePath(await realpath(gitRoot), source),
      )
      const beforeGit = gitAvailable
        ? await captureGitState(source, deadline, hooksDirectory, true)
        : undefined
      if (beforeGit) {
        await initializeGitSnapshot({
          source,
          destination,
          temporaryRoot,
          state: beforeGit,
          deadline,
          hooksDirectory,
        })
      }
      const copied = await captureWorkspace({
        source,
        destination,
        trackedDirectories: beforeGit?.trackedDirectories ?? new Set(),
        deadline,
      })
      const verified = await captureWorkspace({
        source,
        trackedDirectories: beforeGit?.trackedDirectories ?? new Set(),
        deadline,
      })
      if (!sameCapture(copied, verified)) {
        throw new WorkspaceSnapshotError(
          'SNAPSHOT_CHANGED',
          'Workspace changed while the Subagent snapshot was being copied',
        )
      }
      if (beforeGit) {
        const afterGit = await captureGitState(
          source,
          deadline,
          hooksDirectory,
          false,
        )
        if (!sameGitState(beforeGit, afterGit)) {
          throw new WorkspaceSnapshotError(
            'SNAPSHOT_CHANGED',
            'Git HEAD, refs, index, or status changed during snapshot creation',
          )
        }
      }
      deadline.check()
      const identity: WorkspaceSnapshotIdentity = {
        schemaVersion: 1,
        sourceHash: manifestHash(copied.entries),
        fileCount: copied.fileCount,
        totalBytes: copied.totalBytes,
        skippedDirectories: copied.skippedDirectories,
        ...(beforeGit ? { git: gitIdentity(beforeGit) } : {}),
      }
      retained = true
      let disposed = false
      return {
        workspace: destination,
        gitAvailable,
        identity,
        async dispose() {
          if (disposed) return
          disposed = true
          await rm(temporaryRoot, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(temporaryRoot)) {
        throw error
      }
      const message = error.message.split(temporaryRoot).join('[snapshot]')
      if (error instanceof WorkspaceSnapshotError) {
        throw new WorkspaceSnapshotError(error.code, message)
      }
      const sanitized = new Error(message)
      if ('code' in error) {
        Object.assign(sanitized, { code: error.code })
      }
      throw sanitized
    } finally {
      if (!retained) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    }
  }

  /** Converts a snapshot identity to the persistence-safe JSON representation. */
  static identityJson(identity: WorkspaceSnapshotIdentity): JsonValue {
    return JSON.parse(JSON.stringify(identity)) as JsonValue
  }
}
