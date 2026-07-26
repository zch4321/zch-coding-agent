import { spawn } from 'node:child_process'
import path from 'node:path'
import type { BenchmarkCommand } from './contracts'

export interface BenchmarkCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs one benchmark command with bounded output and timeout handling. */
export async function runBenchmarkCommand(input: {
  command: BenchmarkCommand
  workspace: string
  stdin?: string
}): Promise<BenchmarkCommandResult> {
  const cwd = resolveWorkspaceCwd(input.workspace, input.command.cwd)
  return await runBoundedProcess({
    executable: input.command.executable,
    args: input.command.args,
    cwd,
    timeoutMs: input.command.timeoutMs,
    maxOutputBytes: input.command.maxOutputBytes,
    stdin: input.stdin,
  })
}

/** Runs a Git command in a benchmark workspace with bounded output. */
export async function runGit(input: {
  workspace: string
  args: string[]
  timeoutMs?: number
  maxOutputBytes?: number
  stdin?: string
  allowFailure?: boolean
  environment?: Record<string, string>
}): Promise<BenchmarkCommandResult> {
  const result = await runBoundedProcess({
    executable: 'git',
    args: input.args,
    cwd: input.workspace,
    timeoutMs: input.timeoutMs ?? 30_000,
    maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
    stdin: input.stdin,
    environment: input.environment,
  })
  if (result.exitCode !== 0 && !input.allowFailure) {
    throw new Error(
      `Git command failed: ${result.stderr.trim().slice(0, 2_048)}`,
    )
  }
  return result
}

function runBoundedProcess(input: {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  stdin?: string
  environment?: Record<string, string>
}): Promise<BenchmarkCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: safeProcessEnvironment(input.environment),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let settled = false
    const finish = (error?: Error, exitCode?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else {
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        })
      }
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength
      if (bytes > input.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(new Error('Benchmark command output exceeded its byte limit'))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.once('error', (error) => finish(error))
    child.once('close', (exitCode) => finish(undefined, exitCode ?? -1))
    if (input.stdin === undefined) child.stdin.end()
    else child.stdin.end(input.stdin)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, input.timeoutMs)
  })
}

function resolveWorkspaceCwd(workspace: string, relative?: string): string {
  const candidate = path.resolve(workspace, relative ?? '.')
  const relation = path.relative(workspace, candidate)
  if (
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error('Benchmark command cwd escapes workspace')
  }
  return candidate
}

function safeProcessEnvironment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'WINDIR',
  ]
  const environment = Object.fromEntries(
    allowed
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  )
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || /[\0\r\n]/u.test(value)) {
      throw new Error('Benchmark process environment override is invalid')
    }
    environment[name] = value
  }
  return environment
}
