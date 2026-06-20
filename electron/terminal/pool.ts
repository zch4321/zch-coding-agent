import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import * as nodePty from 'node-pty'
import type { SessionId, TerminalId } from '../../shared/ids'
import type {
  TerminalInfo,
  TerminalSnapshot,
  TerminalStatus,
} from '../../shared/terminal'
import { PathGuard, PathGuardError } from '../agent/path-guard'
import { createCommandEnvironment } from '../process/run'
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
  emit: (event: TerminalEventDraft) => void
  spawnPty?: (
    shell: string,
    args: string[],
    options: nodePty.IPtyForkOptions,
  ) => PtyLike
}

interface TerminalResource {
  info: TerminalInfo
  sessionId: SessionId
  pty: PtyLike
  scrollback: ByteRingBuffer
  dataDisposable: { dispose(): void }
  exitDisposable: { dispose(): void }
  explicitClose: boolean
}

function terminalId(): TerminalId {
  return `terminal:${randomUUID()}` as TerminalId
}

function defaultShell(): string {
  return process.platform === 'win32'
    ? 'powershell.exe'
    : (process.env.SHELL ?? '/bin/sh')
}

function cloneInfo(info: TerminalInfo): TerminalInfo {
  return { ...info }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

export class TerminalPool {
  readonly #options: TerminalPoolOptions
  readonly #resources = new Map<TerminalId, TerminalResource>()
  readonly #closedOwners = new Map<TerminalId, SessionId>()

  constructor(options: TerminalPoolOptions) {
    this.#options = options
  }

  async open(input: {
    sessionId: SessionId
    workspace: string
    cwd?: string
    shell?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const guard = PathGuard.fromCanonical(input.workspace)
    const guarded = await guard.resolveExisting(input.cwd ?? '.')
    const cwdStat = await stat(guarded.realPath)

    if (!cwdStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        'Terminal cwd is not a directory',
      )
    }

    const id = terminalId()
    const shell = input.shell ?? defaultShell()
    const cols = input.cols ?? 100
    const rows = input.rows ?? 30
    const environment = createCommandEnvironment()
    delete environment.NO_COLOR
    environment.TERM = 'xterm-256color'
    environment.COLORTERM = 'truecolor'
    const spawnPty = this.#options.spawnPty ?? nodePty.spawn
    const pty = spawnPty(shell, [], {
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
    const resource: TerminalResource = {
      info,
      sessionId: input.sessionId,
      pty,
      scrollback: new ByteRingBuffer(this.#options.getScrollbackBytes()),
      dataDisposable: { dispose: () => undefined },
      exitDisposable: { dispose: () => undefined },
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
      if (!resource.explicitClose) {
        this.#emitStatus(resource, 'closed', exitCode)
      }
    })
    this.#emitStatus(resource, 'running')
    return cloneInfo(resource.info)
  }

  list(sessionId: SessionId): TerminalInfo[] {
    return [...this.#resources.values()]
      .filter((resource) => resource.sessionId === sessionId)
      .map((resource) => cloneInfo(resource.info))
  }

  write(sessionId: SessionId, id: TerminalId, data: string): boolean {
    const resource = this.#requireOwned(sessionId, id)

    if (resource.info.status !== 'running') {
      return false
    }

    resource.pty.write(data)
    return true
  }

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

    this.#disposeResource(resource)
    return true
  }

  closeSession(sessionId: SessionId): void {
    for (const resource of [...this.#resources.values()]) {
      if (resource.sessionId === sessionId) {
        this.#disposeResource(resource)
      }
    }
  }

  dispose(): void {
    for (const resource of [...this.#resources.values()]) {
      this.#disposeResource(resource)
    }
  }

  #requireOwned(sessionId: SessionId, id: TerminalId): TerminalResource {
    const resource = this.#resources.get(id)

    if (!resource || resource.sessionId !== sessionId) {
      throw new Error('Terminal not found for this session')
    }

    return resource
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

  #disposeResource(resource: TerminalResource): void {
    if (!this.#resources.has(resource.info.terminalId)) {
      return
    }

    resource.explicitClose = true
    resource.dataDisposable.dispose()
    resource.exitDisposable.dispose()

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
  }
}
