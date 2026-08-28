import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmod,
  mkdir,
  open,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import {
  touchSessionTempPath,
  type SessionTempPaths,
} from '../session-temp/service'
import {
  BoundedProcessOutput,
  type BoundedOutputSnapshot,
} from './bounded-output'

const DEFAULT_TERMINATION_GRACE_MS = 750

const ENV_ALLOWLIST = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const

export type CommandSpec =
  | {
      mode: 'process'
      executable: string
      args?: string[]
      cwd?: string
    }
  | {
      mode: 'shell'
      executable: string
      args: string[]
      environment?: Record<string, string | undefined>
      fallbackEncoding?: string
      cwd?: string
    }

export interface RunCommandOptions {
  workspace: string
  command: CommandSpec
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
  terminationGraceMs?: number
  sessionTemp?: SessionTempPaths
  artifactKey?: string
}

export interface RunCommandResult extends BoundedOutputSnapshot {
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  cwd: string
  terminationStrategy: 'none' | 'taskkill' | 'process-group'
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
}

/** Builds a child-process environment with the allowed variables and safe proxy settings. */
export function createCommandEnvironment(
  source: Record<string, string | undefined> = process.env,
  sessionTemp?: SessionTempPaths,
): NodeJS.ProcessEnv {
  const nodeEnvironment =
    source.NODE_ENV === 'development' ||
    source.NODE_ENV === 'test' ||
    source.NODE_ENV === 'production'
      ? source.NODE_ENV
      : 'production'
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnvironment,
  }

  for (const key of ENV_ALLOWLIST) {
    const value = source[key]

    if (value !== undefined) {
      environment[key] = value
    }
  }

  environment.NO_COLOR = '1'
  if (sessionTemp) {
    environment.ZCH_SESSION_TEMP_DIR = sessionTemp.root
    environment.ZCH_SESSION_ARTIFACTS_DIR = sessionTemp.artifacts
    environment.ZCH_SESSION_SCRATCH_DIR = sessionTemp.scratch
  }
  return environment
}

async function resolveWorkingDirectory(
  workspace: string,
  sessionTempRoot: string | undefined,
  requested: string | undefined,
): Promise<string> {
  const guard = PathGuard.fromCanonical(workspace, sessionTempRoot)
  const guarded = await guard.resolveExisting(requested ?? '.')
  const directoryStat = await stat(guarded.realPath)

  if (!directoryStat.isDirectory()) {
    throw new PathGuardError(
      'NOT_A_DIRECTORY',
      'Command cwd is not a directory',
    )
  }

  return guarded.realPath
}

interface CommandArtifactCapture {
  directory: string
  sessionTemp: SessionTempPaths
  stdout?: FileHandle
  stderr?: FileHandle
  stdoutTail: Promise<void>
  stderrTail: Promise<void>
  captureError?: string
}

/** Creates the always-on command capture files before spawning the process. */
async function createArtifactCapture(
  sessionTemp: SessionTempPaths | undefined,
  artifactKey: string | undefined,
): Promise<CommandArtifactCapture | undefined> {
  if (!sessionTemp || !artifactKey) return undefined
  const directory = path.join(sessionTemp.artifacts, 'commands', artifactKey)
  let stdout: FileHandle | undefined
  let stderr: FileHandle | undefined
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    stdout = await open(path.join(directory, 'stdout.log'), 'w', 0o600)
    stderr = await open(path.join(directory, 'stderr.log'), 'w', 0o600)
    if (process.platform !== 'win32') {
      await Promise.all([stdout.chmod(0o600), stderr.chmod(0o600)])
    }
    return {
      directory,
      sessionTemp,
      stdout,
      stderr,
      stdoutTail: Promise.resolve(),
      stderrTail: Promise.resolve(),
    }
  } catch (error) {
    await Promise.allSettled([stdout?.close(), stderr?.close()])
    return {
      directory,
      sessionTemp,
      stdoutTail: Promise.resolve(),
      stderrTail: Promise.resolve(),
      captureError: error instanceof Error ? error.message : String(error),
    }
  }
}

function appendArtifact(
  capture: CommandArtifactCapture | undefined,
  stream: 'stdout' | 'stderr',
  chunk: Buffer,
): void {
  if (!capture || capture.captureError) return
  const handle = capture[stream]
  if (!handle) return
  const tailKey = stream === 'stdout' ? 'stdoutTail' : 'stderrTail'
  capture[tailKey] = capture[tailKey]
    .then(async () => {
      await handle.write(chunk)
    })
    .catch((error: unknown) => {
      capture.captureError =
        error instanceof Error ? error.message : String(error)
    })
}

async function finishArtifactCapture(
  capture: CommandArtifactCapture | undefined,
  result: unknown,
): Promise<
  Pick<RunCommandResult, 'artifactAvailable' | 'artifactPath' | 'captureError'>
> {
  if (!capture) return { artifactAvailable: false }
  await Promise.allSettled([capture.stdoutTail, capture.stderrTail])
  const closed = await Promise.allSettled([
    capture.stdout?.close(),
    capture.stderr?.close(),
  ])
  const closeFailure = closed.find(
    (settlement): settlement is PromiseRejectedResult =>
      settlement.status === 'rejected',
  )
  if (closeFailure) {
    capture.captureError ??=
      closeFailure.reason instanceof Error
        ? closeFailure.reason.message
        : String(closeFailure.reason)
  }
  if (!capture.captureError) {
    try {
      const resultPath = path.join(capture.directory, 'result.json')
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await touchSessionTempPath(capture.sessionTemp)
    } catch (error) {
      capture.captureError =
        error instanceof Error ? error.message : String(error)
    }
  }
  return capture.captureError
    ? {
        artifactAvailable: false,
        captureError: capture.captureError,
      }
    : { artifactAvailable: true, artifactPath: capture.directory }
}

function commandFailureResult(
  error: unknown,
  output: BoundedOutputSnapshot,
  startedAt: number,
  cwd: string,
): Record<string, unknown> {
  return {
    ...output,
    exitCode: null,
    exitSignal: null,
    timedOut: false,
    cancelled: false,
    durationMs: performance.now() - startedAt,
    cwd,
    terminationStrategy: 'none',
    error: {
      code:
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'COMMAND_SPAWN_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function attachArtifactToError(
  error: unknown,
  artifact: Pick<
    RunCommandResult,
    'artifactAvailable' | 'artifactPath' | 'captureError'
  >,
): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const details = artifact.artifactPath
    ? `artifactPath=${artifact.artifactPath}`
    : `artifactAvailable=false${
        artifact.captureError ? `; captureError=${artifact.captureError}` : ''
      }`
  const wrapped = new Error(`${source.message}; ${details}`, { cause: source })
  if ('code' in source)
    Reflect.set(wrapped, 'code', Reflect.get(source, 'code'))
  return wrapped
}

function waitForExit(processToWait: ChildProcess): Promise<{
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
}> {
  return new Promise((resolve, reject) => {
    processToWait.once('error', reject)
    processToWait.once('close', (exitCode, exitSignal) => {
      resolve({ exitCode, exitSignal })
    })
  })
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ['/pid', String(pid), '/T']

    if (force) {
      args.push('/F')
    }

    const killer = spawn('taskkill.exe', args, {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => resolve())
    killer.once('close', () => resolve())
  })
}

async function forceKillTree(
  child: ChildProcess,
): Promise<'taskkill' | 'process-group'> {
  if (!child.pid) {
    return process.platform === 'win32' ? 'taskkill' : 'process-group'
  }

  if (process.platform === 'win32') {
    await runTaskkill(child.pid, true)
    return 'taskkill'
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }

  return 'process-group'
}

function requestTreeExit(
  child: ChildProcess,
): RunCommandResult['terminationStrategy'] {
  if (!child.pid) {
    child.kill()
    return 'none'
  }

  if (process.platform === 'win32') {
    void runTaskkill(child.pid, false)
    return 'taskkill'
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill()
  }

  return 'process-group'
}

/** Executes a command with bounded output, timeout, abort, and exit-status handling. */
export async function runCommand(
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  if (options.signal.aborted) {
    throw options.signal.reason
  }

  const cwd = await resolveWorkingDirectory(
    path.resolve(options.workspace),
    options.sessionTemp?.root,
    options.command.cwd,
  )
  const artifactCapture = await createArtifactCapture(
    options.sessionTemp,
    options.artifactKey,
  )
  const output = new BoundedProcessOutput(
    options.maxOutputBytes,
    options.command.mode === 'shell'
      ? options.command.fallbackEncoding
      : undefined,
  )
  const startedAt = performance.now()
  let child: ChildProcess

  try {
    if (options.command.mode === 'process') {
      child = spawn(options.command.executable, options.command.args ?? [], {
        cwd,
        env: createCommandEnvironment(process.env, options.sessionTemp),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else {
      child = spawn(options.command.executable, options.command.args, {
        cwd,
        env: {
          ...createCommandEnvironment(process.env, options.sessionTemp),
          ...options.command.environment,
        },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
  } catch (error) {
    const artifact = await finishArtifactCapture(
      artifactCapture,
      commandFailureResult(error, output.snapshot(), startedAt, cwd),
    )
    throw attachArtifactToError(error, artifact)
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    output.append('stdout', chunk)
    appendArtifact(artifactCapture, 'stdout', chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output.append('stderr', chunk)
    appendArtifact(artifactCapture, 'stderr', chunk)
  })

  let timedOut = false
  let cancelled = false
  let terminationStrategy: RunCommandResult['terminationStrategy'] = 'none'
  let terminationStarted = false
  let forceTimer: NodeJS.Timeout | undefined

  const terminate = () => {
    if (terminationStarted || child.exitCode !== null) {
      return
    }

    terminationStarted = true
    terminationStrategy = requestTreeExit(child)
    forceTimer = setTimeout(() => {
      if (child.exitCode === null) {
        void forceKillTree(child).then((strategy) => {
          terminationStrategy = strategy
        })
      }
    }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS)
    forceTimer.unref()
  }
  const abort = () => {
    cancelled = true
    terminate()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => {
      timedOut = true
      terminate()
    },
    Math.max(1, options.timeoutMs),
  )

  try {
    let exited: Awaited<ReturnType<typeof waitForExit>>
    try {
      exited = await waitForExit(child)
    } catch (error) {
      const artifact = await finishArtifactCapture(
        artifactCapture,
        commandFailureResult(error, output.snapshot(), startedAt, cwd),
      )
      throw attachArtifactToError(error, artifact)
    }
    const result = {
      ...output.snapshot(),
      ...exited,
      timedOut,
      cancelled,
      durationMs: performance.now() - startedAt,
      cwd,
      terminationStrategy,
    }
    return {
      ...result,
      ...(await finishArtifactCapture(artifactCapture, result)),
    }
  } finally {
    clearTimeout(timeout)
    if (forceTimer) {
      clearTimeout(forceTimer)
    }
    options.signal.removeEventListener('abort', abort)
  }
}
