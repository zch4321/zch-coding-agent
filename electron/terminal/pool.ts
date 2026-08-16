import { stat } from 'node:fs/promises'
import path from 'node:path'
import * as nodePty from 'node-pty'
import type { SessionId, TerminalId } from '../../shared/ids'
import type {
  CommandShellProfile,
  CommandShellSelection,
} from '../../shared/command-shell'
import type {
  TerminalInfo,
  TerminalSnapshot,
  TerminalStatus,
} from '../../shared/terminal'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import { createCommandEnvironment } from '../process/run'
import {
  commandShellService,
  POWERSHELL_PROCESS_EXECUTION_POLICY_ARGS,
} from '../process/command-shell'
import { ByteRingBuffer } from './byte-ring-buffer'

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu

export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void
  }
}

export interface TerminalEventDraft {
  type: 'terminal.output' | 'terminal.status'
  sessionId: SessionId
  terminalId: TerminalId
  seq: number
  chunk?: string
  status?: TerminalStatus
  exitCode?: number | null
}

export interface TerminalPoolOptions {
  getScrollbackBytes: () => number
  getCommandShellSelection?: () => CommandShellSelection
  emit: (event: TerminalEventDraft) => void
  resolveShellProfile?: (
    selection: CommandShellSelection,
  ) => Promise<CommandShellProfile>
  spawnPty?: (
    shell: string,
    args: string[],
    options: nodePty.IPtyForkOptions,
  ) => PtyLike
}

/** Maximum terminals retained per Session, including opening, running, and self-exited entries. */
export const MAX_TERMINALS_PER_SESSION = 16

interface TerminalResource {
  info: TerminalInfo
  sessionId: SessionId
  pty: PtyLike
  scrollback: ByteRingBuffer
  dataDisposable: { dispose(): void }
  exitDisposable: { dispose(): void }
  exitPromise: Promise<void>
  resolveExit: () => void
  explicitClose: boolean
}

let nextTerminalIdValue = 1

/** Allocates process-global incrementing terminal IDs that are never reused within the process. */
function allocateTerminalId(): TerminalId {
  if (nextTerminalIdValue > Number.MAX_SAFE_INTEGER) {
    throw new Error('Terminal id space exhausted')
  }
  const value = nextTerminalIdValue
  nextTerminalIdValue += 1
  return value as TerminalId
}

function cloneInfo(info: TerminalInfo): TerminalInfo {
  return { ...info }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

/** Owns PTY terminal processes per Session, bounded scrollback, and cleanup state. */
export class TerminalPool {
  readonly #options: TerminalPoolOptions
  readonly #resources = new Map<TerminalId, TerminalResource>()
  readonly #closedOwners = new Map<TerminalId, SessionId>()
  readonly #pendingExits = new Set<Promise<void>>()
  readonly #reservations = new Map<SessionId, number>()
  readonly #sessionGenerations = new Map<SessionId, number>()
  #disposed = false

  constructor(options: TerminalPoolOptions) {
    this.#options = options
  }

  /** Creates a PTY terminal for a Session and returns its renderer-safe info. */
  async open(input: {
    sessionId: SessionId
    workspace: string
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    if (this.#disposed) {
      throw new Error('Terminal pool is disposed')
    }
    this.#reserveSlot(input.sessionId)
    try {
      return await this.#openReserved(input)
    } finally {
      this.#releaseSlot(input.sessionId)
    }
  }

  /** Resolves the configured shell and spawns the PTY for an already reserved slot. */
  async #openReserved(input: {
    sessionId: SessionId
    workspace: string
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const generation = this.#sessionGenerations.get(input.sessionId) ?? 0
    const guard = PathGuard.fromCanonical(input.workspace)
    const guarded = await guard.resolveExisting(input.cwd ?? '.')
    const cwdStat = await stat(guarded.realPath)

    if (!cwdStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        'Terminal cwd is not a directory',
      )
    }

    const id = allocateTerminalId()
    const selection = this.#options.getCommandShellSelection?.() ?? 'auto'
    const profile = await this.#resolveShellProfile(selection)
    // Spawn through registration below is synchronous, so this single check
    // covers every await point where closeSession/dispose could interleave.
    this.#assertOpenStillValid(input.sessionId, generation)
    const shell = profile.executable
    const shellArgs =
      profile.kind === 'powershell'
        ? [...POWERSHELL_PROCESS_EXECUTION_POLICY_ARGS]
        : []
    const cols = input.cols ?? 100
    const rows = input.rows ?? 30
    const environment = createCommandEnvironment()
    delete environment.NO_COLOR
    environment.TERM = 'xterm-256color'
    environment.COLORTERM = 'truecolor'
    const spawnPty = this.#options.spawnPty ?? nodePty.spawn
    const pty = spawnPty(shell, shellArgs, {
      name: 'xterm-256color',
      cwd: guarded.realPath,
      cols,
      rows,
      env: environment,
    })
    const info: TerminalInfo = {
      terminalId: id,
      cwd: path.resolve(guarded.realPath),
      shell,
      status: 'opening',
      cols,
      rows,
      seq: 0,
    }
    let resolveExit!: () => void
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const resource: TerminalResource = {
      info,
      sessionId: input.sessionId,
      pty,
      scrollback: new ByteRingBuffer(this.#options.getScrollbackBytes()),
      dataDisposable: { dispose: () => undefined },
      exitDisposable: { dispose: () => undefined },
      exitPromise,
      resolveExit,
      explicitClose: false,
    }
    this.#resources.set(id, resource)
    this.#emitStatus(resource, 'opening')
    resource.dataDisposable = pty.onData((chunk) => {
      resource.scrollback.append(chunk)
      resource.info.seq += 1
      this.#options.emit({
        type: 'terminal.output',
        sessionId: resource.sessionId,
        terminalId: id,
        seq: resource.info.seq,
        chunk,
      })
    })
    resource.exitDisposable = pty.onExit(({ exitCode }) => {
      resource.resolveExit()
      resource.exitDisposable.dispose()
      if (!resource.explicitClose) {
        this.#emitStatus(resource, 'closed', exitCode)
      }
    })
    this.#emitStatus(resource, 'running')
    return cloneInfo(resource.info)
  }

  /** Returns cloned terminal info for terminals owned by a Session, sorted by ascending numeric ID. */
  list(sessionId: SessionId): TerminalInfo[] {
    return [...this.#resources.values()]
      .filter((resource) => resource.sessionId === sessionId)
      .map((resource) => cloneInfo(resource.info))
      .sort((left, right) => left.terminalId - right.terminalId)
  }

  /** Writes input to a running Session-owned PTY. */
  write(sessionId: SessionId, id: TerminalId, data: string): boolean {
    const resource = this.#requireOwned(sessionId, id)

    if (resource.info.status !== 'running') {
      return false
    }

    resource.pty.write(data)
    return true
  }

  /** Resizes a Session-owned PTY after validating its dimensions. */
  resize(
    sessionId: SessionId,
    id: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    const resource = this.#requireOwned(sessionId, id)

    if (resource.info.status !== 'running') {
      return false
    }

    resource.pty.resize(cols, rows)
    resource.info.cols = cols
    resource.info.rows = rows
    return true
  }

  /** Returns terminal process state and bounded scrollback from an optional cursor. */
  snapshot(sessionId: SessionId, id: TerminalId): TerminalSnapshot {
    const resource = this.#requireOwned(sessionId, id)
    const snapshot = resource.scrollback.snapshot()

    return {
      terminal: cloneInfo(resource.info),
      data: snapshot.data,
      cursor: snapshot.cursor,
      truncated: snapshot.truncated || snapshot.startCursor > 0,
      totalBytes: snapshot.totalBytes,
    }
  }

  /** Reads bounded scrollback lines and bytes from a Session-owned terminal. */
  read(
    sessionId: SessionId,
    id: TerminalId,
    options: { cursor?: number; lines?: number; maxBytes: number },
  ): {
    terminalId: TerminalId
    content: string
    cursor: number
    truncated: boolean
    totalBytes: number
  } {
    const resource = this.#requireOwned(sessionId, id)
    const snapshot = resource.scrollback.snapshot(options.cursor)
    let content = stripAnsi(snapshot.data)
    const lines = Math.max(1, options.lines ?? 200)
    const split = content.split(/\r?\n/u)

    if (split.length > lines) {
      content = split.slice(-lines).join('\n')
    }

    const encoded = Buffer.from(content)
    const bounded =
      encoded.byteLength > options.maxBytes
        ? encoded.subarray(encoded.byteLength - options.maxBytes)
        : encoded

    return {
      terminalId: id,
      content: bounded.toString('utf8'),
      cursor: snapshot.cursor,
      truncated:
        snapshot.truncated ||
        split.length > lines ||
        encoded.byteLength > options.maxBytes,
      totalBytes: snapshot.totalBytes,
    }
  }

  /** Closes one terminal and records its owner for idempotent repeated close calls. */
  close(sessionId: SessionId, id: TerminalId): boolean {
    const resource = this.#resources.get(id)

    if (!resource) {
      if (this.#closedOwners.get(id) === sessionId) {
        return false
      }

      throw new Error('Terminal not found for this session')
    }

    if (resource.sessionId !== sessionId) {
      throw new Error('Terminal not found for this session')
    }

    void this.#disposeResource(resource)
    return true
  }

  /** Closes every terminal owned by a Session and invalidates its in-flight opens. */
  closeSession(sessionId: SessionId): void {
    this.#sessionGenerations.set(
      sessionId,
      (this.#sessionGenerations.get(sessionId) ?? 0) + 1,
    )
    for (const resource of [...this.#resources.values()]) {
      if (resource.sessionId === sessionId) {
        void this.#disposeResource(resource)
      }
    }
  }

  /** Closes all terminals, rejects future opens, and waits for pending PTY cleanup. */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const resource of [...this.#resources.values()]) {
      void this.#disposeResource(resource)
    }

    const pending = [...this.#pendingExits]
    if (pending.length === 0) return

    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000)
      }),
    ])
    if (timeout) clearTimeout(timeout)
  }

  #requireOwned(sessionId: SessionId, id: TerminalId): TerminalResource {
    const resource = this.#resources.get(id)

    if (!resource || resource.sessionId !== sessionId) {
      throw new Error('Terminal not found for this session')
    }

    return resource
  }

  /** Raises when the Session closed or the pool was disposed while the open was awaiting. */
  #assertOpenStillValid(sessionId: SessionId, generation: number): void {
    if (this.#disposed) {
      throw new Error('Terminal pool is disposed')
    }
    if ((this.#sessionGenerations.get(sessionId) ?? 0) !== generation) {
      throw new Error('Session closed while the terminal was starting')
    }
  }

  /** Resolves the configured shell selection to a concrete profile with automatic fallback. */
  async #resolveShellProfile(
    selection: CommandShellSelection,
  ): Promise<CommandShellProfile> {
    const resolve =
      this.#options.resolveShellProfile ??
      (async (requested: CommandShellSelection) =>
        (await commandShellService.resolve(requested)).profile)
    return resolve(selection)
  }

  /** Reserves a per-Session terminal slot synchronously so concurrent opens cannot exceed the limit. */
  #reserveSlot(sessionId: SessionId): void {
    if (this.#sessionTerminalCount(sessionId) >= MAX_TERMINALS_PER_SESSION) {
      throw new Error(
        `Session terminal limit reached (${MAX_TERMINALS_PER_SESSION}); close a terminal before opening a new one`,
      )
    }
    this.#reservations.set(
      sessionId,
      (this.#reservations.get(sessionId) ?? 0) + 1,
    )
  }

  /** Releases a slot reservation once the open attempt settled. */
  #releaseSlot(sessionId: SessionId): void {
    const count = this.#reservations.get(sessionId) ?? 0
    if (count <= 1) {
      this.#reservations.delete(sessionId)
    } else {
      this.#reservations.set(sessionId, count - 1)
    }
  }

  /** Counts retained terminals and pending reservations owned by a Session. */
  #sessionTerminalCount(sessionId: SessionId): number {
    let count = this.#reservations.get(sessionId) ?? 0
    for (const resource of this.#resources.values()) {
      if (resource.sessionId === sessionId) count += 1
    }
    return count
  }

  #emitStatus(
    resource: TerminalResource,
    status: TerminalStatus,
    exitCode?: number | null,
  ): void {
    resource.info.status = status
    resource.info.seq += 1
    this.#options.emit({
      type: 'terminal.status',
      sessionId: resource.sessionId,
      terminalId: resource.info.terminalId,
      seq: resource.info.seq,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    })
  }

  #disposeResource(resource: TerminalResource): Promise<void> {
    if (!this.#resources.has(resource.info.terminalId)) {
      return resource.exitPromise
    }

    resource.explicitClose = true
    resource.dataDisposable.dispose()

    try {
      resource.pty.kill()
    } catch {
      // The process may already have exited.
    }

    this.#emitStatus(resource, 'closed', null)
    resource.scrollback.clear()
    this.#resources.delete(resource.info.terminalId)
    this.#closedOwners.set(resource.info.terminalId, resource.sessionId)

    if (this.#closedOwners.size > 256) {
      this.#closedOwners.delete(this.#closedOwners.keys().next().value!)
    }

    const pending = resource.exitPromise.finally(() => {
      resource.exitDisposable.dispose()
      this.#pendingExits.delete(pending)
    })
    this.#pendingExits.add(pending)
    return pending
  }
}
