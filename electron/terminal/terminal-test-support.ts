import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TerminalPool, type PtyLike } from './pool'

/** Models a PTY whose kill request and real exit can be controlled independently. */
export class ControlledPty implements PtyLike {
  readonly pid = 123
  killed = 0
  failKill = false
  exited = false
  writes: string[] = []
  readonly #data = new Set<(data: string) => void>()
  readonly #exit = new Set<(event: { exitCode: number }) => void>()
  write(data: string): void {
    this.writes.push(data)
  }
  resize(): void {}
  kill(): void {
    if (this.failKill) throw new Error('PTY kill failed')
    this.killed += 1
  }
  onData(listener: (data: string) => void) {
    this.#data.add(listener)
    return { dispose: () => this.#data.delete(listener) }
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.#exit.add(listener)
    return { dispose: () => this.#exit.delete(listener) }
  }
  emitData(data: string): void {
    for (const listener of this.#data) listener(data)
  }
  emitExit(exitCode = 0): void {
    if (this.exited) return
    this.exited = true
    for (const listener of this.#exit) listener({ exitCode })
  }
}

/** Builds an isolated artifact-writing terminal pool with manually controlled PTYs. */
export async function createTerminalHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zch-terminal-background-'))
  const sessionTemp = {
    root: path.join(root, 'temp'),
    artifacts: path.join(root, 'temp', 'artifacts'),
    scratch: path.join(root, 'temp', 'scratch'),
  }
  await mkdir(sessionTemp.artifacts, { recursive: true })
  await mkdir(sessionTemp.scratch, { recursive: true })
  const ptys: ControlledPty[] = []
  const pool = new TerminalPool({
    getScrollbackBytes: () => 1024,
    resolveShellProfile: async () => ({
      id: 'system-shell',
      kind: 'posix',
      label: 'sh',
      executable: '/fake/sh',
      source: 'system',
    }),
    spawnPty: () => {
      const pty = new ControlledPty()
      ptys.push(pty)
      return pty
    },
    emit: () => undefined,
  })
  return {
    root,
    sessionTemp,
    pool,
    ptys,
    async dispose() {
      for (const pty of ptys) {
        pty.failKill = false
        pty.emitExit()
      }
      await pool.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
