import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { RunId, SessionId } from '../../shared/ids'
import type { DiagnosticSink } from '../diagnostics'
import type { SessionTempPaths } from '../session-temp/service'
import { CommandOutput } from './command-output'
import { terminateProcessTree } from './process-tree'
import {
  appendArtifact,
  createArtifactCapture,
  createCommandEnvironment,
  finishArtifactCapture,
  resolveWorkingDirectory,
  type CommandArtifactCapture,
  type CommandSpec,
} from './run'

export const MAX_ACTIVE_COMMAND_SESSIONS = 16
export const MAX_FINISHED_COMMAND_SESSIONS = 256
const MAX_QUEUED_INPUT_BYTES = 262_144

export interface CommandOwner {
  sessionId: SessionId
  runId: RunId
}
export interface CommandStartInput {
  workspace: string
  command: CommandSpec
  sessionTemp?: SessionTempPaths
  artifactKey: string
  maxOutputBytes: number
  launch: {
    command?: string
    executable?: string
    args?: string[]
    cwd?: string
  }
}
export interface CommandSessionSnapshot {
  sessionId: string
  state: 'running' | 'stopping' | 'exited' | 'failed'
  stdout: string
  stderr: string
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stdinClosed: boolean
  truncated: boolean
  totalBytes: number
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
  inputError?: string
  stopError?: string
}

interface Completion {
  promise: Promise<void>
  resolve: () => void
}
function completion(): Completion {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface CommandEntry {
  id: string
  scope: RunScope
  launch: CommandStartInput['launch']
  state: CommandSessionSnapshot['state']
  output: CommandOutput
  child?: ChildProcess
  capture?: CommandArtifactCapture
  finished: Completion
  ready: Completion
  listeners: Set<() => void>
  startedAt: number
  cwd: string
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stdinClosed: boolean
  settled: boolean
  finalizing: boolean
  stopRequested: boolean
  stopError?: string
  inputError?: string
  spawnError?: string
  captureResult?: Pick<
    CommandSessionSnapshot,
    'artifactAvailable' | 'artifactPath' | 'captureError'
  >
  forceTimer?: NodeJS.Timeout
  stopping?: Promise<void>
  totalBytes: number
}
interface RunScope {
  owner: CommandOwner
  entries: Map<string, CommandEntry>
  active: number
  finishedIds: string[]
  closing: boolean
  signal: AbortSignal
  onAbort: () => void
  cleanup?: Promise<void>
}

/** Identifies expected command-control failures without hiding the original process state. */
export class CommandSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandSessionError'
  }
}

/** Owns non-PTY processes for exactly one Run each, including all asynchronous cleanup. */
export class CommandSessionManager {
  readonly #runs = new Map<RunId, RunScope>()
  readonly #spawn: typeof spawn
  readonly #terminate: typeof terminateProcessTree
  readonly #finishCapture: typeof finishArtifactCapture
  readonly #diagnostic?: DiagnosticSink
  readonly #graceMs: number

  constructor(
    options: {
      spawn?: typeof spawn
      terminate?: typeof terminateProcessTree
      finishCapture?: typeof finishArtifactCapture
      onDiagnostic?: DiagnosticSink
      terminationGraceMs?: number
    } = {},
  ) {
    this.#spawn = options.spawn ?? spawn
    this.#terminate = options.terminate ?? terminateProcessTree
    this.#finishCapture = options.finishCapture ?? finishArtifactCapture
    this.#diagnostic = options.onDiagnostic
    this.#graceMs = options.terminationGraceMs ?? 750
  }

  /** Registers the Run signal once so yielding a tool call never detaches process ownership. */
  beginRun(owner: CommandOwner, signal: AbortSignal): void {
    if (this.#runs.has(owner.runId))
      throw new CommandSessionError(
        'EXEC_RUN_EXISTS',
        'Exec Run scope already exists',
      )
    const scope: RunScope = {
      owner,
      entries: new Map(),
      active: 0,
      finishedIds: [],
      closing: false,
      signal,
      onAbort: () => this.stopRun(owner),
    }
    this.#runs.set(owner.runId, scope)
    signal.addEventListener('abort', scope.onAbort, { once: true })
    if (signal.aborted) this.stopRun(owner)
  }

  /** Reserves capacity before asynchronous preparation, then starts a pipe-backed child process. */
  async start(owner: CommandOwner, input: CommandStartInput): Promise<string> {
    const scope = this.#scope(owner)
    this.#assertOpen(scope)
    if (scope.active >= MAX_ACTIVE_COMMAND_SESSIONS)
      throw new CommandSessionError(
        'EXEC_CAPACITY_EXCEEDED',
        'This Run already owns 16 active exec processes',
      )
    scope.active++
    const entry: CommandEntry = {
      id: `exec:${randomUUID()}`,
      scope,
      launch: structuredClone(input.launch),
      state: 'running',
      output: new CommandOutput(
        input.maxOutputBytes,
        input.command.mode === 'shell'
          ? input.command.fallbackEncoding
          : undefined,
      ),
      ready: completion(),
      finished: completion(),
      listeners: new Set(),
      startedAt: performance.now(),
      cwd: '',
      exitCode: null,
      exitSignal: null,
      stdinClosed: false,
      settled: false,
      finalizing: false,
      stopRequested: false,
      totalBytes: 0,
    }
    scope.entries.set(entry.id, entry)
    try {
      entry.cwd = await resolveWorkingDirectory(
        input.workspace,
        input.sessionTemp,
        input.command.cwd,
      )
      this.#assertOpen(scope)
      entry.capture = await createArtifactCapture(
        input.sessionTemp,
        input.artifactKey,
      )
      this.#assertOpen(scope)
      const child = this.#spawn(
        input.command.executable,
        input.command.args ?? [],
        {
          cwd: entry.cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: {
            ...createCommandEnvironment(process.env, input.sessionTemp),
            ...(input.command.mode === 'shell'
              ? input.command.environment
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      entry.child = child
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.on('data', (value: Buffer) => {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
          entry.totalBytes += bytes.length
          entry.output.append(stream, bytes)
          appendArtifact(entry.capture, stream, bytes)
        })
      }
      child.stdin?.on('error', (error: Error) => {
        entry.inputError = error.message
        entry.stdinClosed = true
      })
      child.stdin?.on('close', () => {
        entry.stdinClosed = true
      })
      child.once('close', (code, signal) => {
        entry.exitCode = code
        entry.exitSignal = signal
        void this.#settle(entry)
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', (error) => {
          entry.spawnError = error.message
          reject(error)
        })
      })
      if (scope.closing || scope.signal.aborted) this.#requestStop(entry)
      return entry.id
    } catch (error) {
      entry.spawnError ??=
        error instanceof Error ? error.message : String(error)
      if (!entry.child) await this.#settle(entry)
      throw new CommandSessionError(
        'EXEC_START_FAILED',
        `${entry.spawnError}; sessionId=${entry.id}${entry.capture?.directory ? `; artifactPath=${entry.capture.directory}; artifactType=directory` : ''}`,
      )
    } finally {
      entry.ready.resolve()
    }
  }

  /** Validates exact Run ownership and returns launch context for stdin approval. */
  describe(
    owner: CommandOwner,
    sessionId: string,
  ): CommandStartInput['launch'] {
    const entry = this.#entry(owner, sessionId)
    return { ...structuredClone(entry.launch), cwd: entry.cwd }
  }

  /** Queues bounded input in Node's ordered stdin stream, optionally ending it with EOF. */
  write(
    owner: CommandOwner,
    sessionId: string,
    text: string,
    closeStdin = false,
  ): void {
    const entry = this.#entry(owner, sessionId)
    this.#assertOpen(entry.scope)
    const stdin = entry.child?.stdin
    if (
      entry.state !== 'running' ||
      entry.stdinClosed ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      throw new CommandSessionError(
        'EXEC_STDIN_CLOSED',
        'This exec process no longer accepts stdin',
      )
    }
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length + stdin.writableLength > MAX_QUEUED_INPUT_BYTES)
      throw new CommandSessionError(
        'EXEC_STDIN_BACKPRESSURE',
        'Exec stdin queue is full; no input was accepted. Wait before retrying.',
      )
    try {
      if (bytes.length)
        stdin.write(bytes, (error) => {
          if (error) {
            entry.inputError = error.message
            entry.stdinClosed = true
          }
        })
      if (closeStdin) {
        entry.stdinClosed = true
        stdin.end()
      }
    } catch (error) {
      entry.inputError = error instanceof Error ? error.message : String(error)
      throw new CommandSessionError(
        'EXEC_STDIN_FAILED',
        `${entry.inputError}; input may have been partially accepted; do not automatically resend it`,
      )
    }
  }

  /** Requests an idempotent stop; only an actual close and capture settlement release the slot. */
  terminate(owner: CommandOwner, sessionId: string): void {
    this.#requestStop(this.#entry(owner, sessionId))
  }

  /** Waits for exit, a stop request, or the sampling deadline, then consumes unread output. */
  async read(
    owner: CommandOwner,
    sessionId: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<CommandSessionSnapshot> {
    const entry = this.#entry(owner, sessionId)
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000)
      throw new CommandSessionError(
        'EXEC_WAIT_INVALID',
        'Exec wait must be between 0 and 60000 ms',
      )
    if (signal.aborted) throw signal.reason
    const alreadyStopping = entry.stopRequested
    if (waitMs > 0 && !entry.settled) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          entry.listeners.delete(done)
          signal.removeEventListener('abort', abort)
        }
        const done = () => {
          cleanup()
          resolve()
        }
        const abort = () => {
          cleanup()
          reject(signal.reason)
        }
        const timer = setTimeout(done, waitMs)
        entry.listeners.add(done)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else if (entry.settled || (entry.stopRequested && !alreadyStopping))
          done()
      })
    }
    if (signal.aborted) throw signal.reason
    return {
      sessionId: entry.id,
      state: entry.state,
      ...entry.output.read(),
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      stdinClosed: entry.stdinClosed,
      ...(entry.captureResult ?? this.#captureStatus(entry)),
      ...(entry.inputError ? { inputError: entry.inputError } : {}),
      ...(entry.stopError ? { stopError: entry.stopError } : {}),
    }
  }

  /** Blocks further launches and stdin writes and retries termination of this Run's processes. */
  stopRun(owner: CommandOwner): void {
    const scope = this.#runs.get(owner.runId)
    if (!scope || scope.owner.sessionId !== owner.sessionId) return
    scope.closing = true
    for (const entry of scope.entries.values()) this.#requestStop(entry)
  }

  /** Stops remaining processes and keeps ownership until preparation, exit, and artifact cleanup finish. */
  finishRun(owner: CommandOwner): Promise<void> {
    const scope = this.#runs.get(owner.runId)
    if (!scope || scope.owner.sessionId !== owner.sessionId)
      return Promise.resolve()
    this.stopRun(owner)
    scope.cleanup ??= (async () => {
      const entries = [...scope.entries.values()]
      await Promise.all(entries.map((entry) => entry.ready.promise))
      for (const entry of entries) this.#requestStop(entry)
      await Promise.all(entries.map((entry) => entry.finished.promise))
      scope.signal.removeEventListener('abort', scope.onAbort)
      scope.entries.clear()
      scope.finishedIds.length = 0
      this.#runs.delete(owner.runId)
    })()
    return scope.cleanup
  }

  /** Stops and settles every remaining Run before the host shuts down. */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#runs.values()].map((scope) => this.finishRun(scope.owner)),
    )
  }

  #scope(owner: CommandOwner): RunScope {
    const scope = this.#runs.get(owner.runId)
    if (!scope || scope.owner.sessionId !== owner.sessionId)
      throw new CommandSessionError(
        'EXEC_SESSION_NOT_FOUND',
        'Exec session was not found for this Run or backend instance',
      )
    return scope
  }

  #entry(owner: CommandOwner, id: string): CommandEntry {
    const entry = this.#scope(owner).entries.get(id)
    if (!entry)
      throw new CommandSessionError(
        'EXEC_SESSION_NOT_FOUND',
        'Exec session was not found for this Run or backend instance (it may have expired)',
      )
    return entry
  }

  #assertOpen(scope: RunScope): void {
    if (scope.closing || scope.signal.aborted)
      throw new CommandSessionError(
        'EXEC_RUN_CLOSING',
        'This Run is finishing; new exec processes and stdin writes are blocked',
      )
  }

  #captureStatus(
    entry: CommandEntry,
  ): Pick<
    CommandSessionSnapshot,
    'artifactAvailable' | 'artifactPath' | 'captureError'
  > {
    if (entry.capture?.directory && !entry.capture.captureError)
      return { artifactAvailable: true, artifactPath: entry.capture.directory }
    return {
      artifactAvailable: false,
      ...(entry.capture?.captureError
        ? { captureError: entry.capture.captureError }
        : {}),
    }
  }

  #requestStop(entry: CommandEntry): void {
    if (entry.settled || entry.finalizing) return
    entry.stopRequested = true
    entry.state = 'stopping'
    for (const listener of [...entry.listeners]) listener()
    if (!entry.child) return
    this.#kill(entry, false)
    entry.forceTimer ??= setTimeout(() => {
      entry.forceTimer = undefined
      this.#kill(entry, true)
    }, this.#graceMs)
    entry.forceTimer.unref()
  }

  #kill(entry: CommandEntry, force: boolean): void {
    if (!entry.child || entry.settled || entry.finalizing) return
    if (entry.stopping) {
      if (force) void entry.stopping.then(() => this.#kill(entry, true))
      return
    }
    entry.stopping = this.#terminate(entry.child, force)
      .then(() => {
        entry.stopError = undefined
      })
      .catch((error: unknown) => {
        if (entry.settled || entry.finalizing) return
        entry.stopError = error instanceof Error ? error.message : String(error)
        if (force)
          this.#diagnostic?.('Exec process termination failed', error, {
            audience: 'notification',
            severity: 'error',
            code: 'EXEC_STOP_FAILED',
            sessionId: entry.scope.owner.sessionId,
            message:
              'An exec process could not be stopped. Stop the Run again to retry; cleanup is still pending.',
          })
      })
      .finally(() => {
        entry.stopping = undefined
      })
  }

  async #settle(entry: CommandEntry): Promise<void> {
    if (entry.finalizing || entry.settled) return
    entry.finalizing = true
    entry.state = 'stopping'
    entry.stdinClosed = true
    if (entry.forceTimer) clearTimeout(entry.forceTimer)
    entry.output.finish()
    try {
      entry.captureResult = await this.#finishCapture(entry.capture, {
        sessionId: entry.id,
        state: entry.spawnError ? 'failed' : 'exited',
        exitCode: entry.exitCode,
        exitSignal: entry.exitSignal,
        stopRequested: entry.stopRequested,
        totalBytes: entry.totalBytes,
        durationMs: performance.now() - entry.startedAt,
        cwd: entry.cwd,
        ...(entry.spawnError ? { error: entry.spawnError } : {}),
      })
    } catch (error) {
      entry.captureResult = {
        artifactAvailable: false,
        captureError: error instanceof Error ? error.message : String(error),
      }
    }
    entry.state = entry.spawnError ? 'failed' : 'exited'
    entry.settled = true
    entry.scope.active--
    entry.scope.finishedIds.push(entry.id)
    while (entry.scope.finishedIds.length > MAX_FINISHED_COMMAND_SESSIONS)
      entry.scope.entries.delete(entry.scope.finishedIds.shift()!)
    entry.finished.resolve()
    for (const listener of [...entry.listeners]) listener()
  }
}
