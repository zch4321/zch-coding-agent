import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { PathGuard, PathGuardError } from '../safety/path-guard'
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
      command: string
      cwd?: string
    }

export interface RunCommandOptions {
  workspace: string
  command: CommandSpec
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
  terminationGraceMs?: number
}

export interface RunCommandResult extends BoundedOutputSnapshot {
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  cwd: string
  terminationStrategy: 'none' | 'taskkill' | 'process-group'
}

export function createCommandEnvironment(
  source: Record<string, string | undefined> = process.env,
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
  return environment
}

async function resolveWorkingDirectory(
  workspace: string,
  requested: string | undefined,
): Promise<string> {
  const guard = PathGuard.fromCanonical(workspace)
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

export async function runCommand(
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  if (options.signal.aborted) {
    throw options.signal.reason
  }

  const cwd = await resolveWorkingDirectory(
    path.resolve(options.workspace),
    options.command.cwd,
  )
  const output = new BoundedProcessOutput(options.maxOutputBytes)
  const startedAt = performance.now()
  let child: ChildProcess

  if (options.command.mode === 'process') {
    child = spawn(options.command.executable, options.command.args ?? [], {
      cwd,
      env: createCommandEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    child = spawn(options.command.command, {
      cwd,
      env: createCommandEnvironment(),
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  child.stdout?.on('data', (chunk: Buffer) => output.append('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => output.append('stderr', chunk))

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
    const exited = await waitForExit(child)
    return {
      ...output.snapshot(),
      ...exited,
      timedOut,
      cancelled,
      durationMs: performance.now() - startedAt,
      cwd,
      terminationStrategy,
    }
  } finally {
    clearTimeout(timeout)
    if (forceTimer) {
      clearTimeout(forceTimer)
    }
    options.signal.removeEventListener('abort', abort)
  }
}
