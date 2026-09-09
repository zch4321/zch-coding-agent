import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import type { RunId, SessionId } from '../../shared/ids'
import {
  CommandSessionManager,
  type CommandOwner,
  type CommandStartInput,
} from './command-sessions'

/** Provides separately controlled process output, stdin, and close events for lifecycle tests. */
export class ControlledCommand extends EventEmitter {
  readonly pid = 12345
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly input: Buffer[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  closed = false

  constructor() {
    super()
    this.stdin.on('data', (data: Buffer) => this.input.push(Buffer.from(data)))
  }

  /** Emits real-close semantics only when the test decides the process has exited. */
  close(code = 0): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, null)
  }
}

/** Creates a typed Run identity independent of the opaque exec session handle. */
export function commandOwner(name = 'test'): CommandOwner {
  return {
    sessionId: `session:${name}` as SessionId,
    runId: `run:${name}` as RunId,
  }
}

/** Supplies a harmless direct-process specification for the controlled spawn adapter. */
export function commandInput(
  overrides: Partial<CommandStartInput> = {},
): CommandStartInput {
  return {
    workspace: process.cwd(),
    command: { mode: 'process', executable: 'fixture' },
    artifactKey: 'fixture',
    maxOutputBytes: 4096,
    launch: { executable: 'fixture' },
    ...overrides,
  }
}

/** Builds a lifecycle harness whose stop requests never imply actual process exit. */
export function controlledCommands(
  options: ConstructorParameters<typeof CommandSessionManager>[0] = {},
) {
  const children: ControlledCommand[] = []
  const stops: Array<{ child: ChildProcess; force: boolean }> = []
  const manager = new CommandSessionManager({
    spawn: (() => {
      const child = new ControlledCommand()
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child as unknown as ChildProcess
    }) as typeof spawn,
    terminate: async (child, force) => {
      stops.push({ child, force })
    },
    ...options,
  })
  return { manager, children, stops }
}
