import { chmod, mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import * as nodePty from 'node-pty'
import { delay } from '../../shared/async/delay'
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
import {
  touchSessionTempPath,
  type SessionTempPaths,
} from '../session-temp/service'
import { AnsiStreamSanitizer } from './ansi-stream-sanitizer'

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
/** Fixed Terminal tail returned by background_wait snapshots. */
export const TERMINAL_BACKGROUND_TAIL_LINES = 50
const TERMINAL_BACKGROUND_TAIL_BYTES = 256 * 1_024

interface TerminalResource {
  info: TerminalInfo
  sessionId: SessionId
  ownerSessionId: SessionId
  pty: PtyLike
  scrollback: ByteRingBuffer
  modelScrollback: ByteRingBuffer
  sanitizer: AnsiStreamSanitizer
  dataDisposable: { dispose(): void }
  exitDisposable: { dispose(): void }
  exitPromise: Promise<void>
  resolveExit: () => void
  explicitClose: boolean
  exitCode: number | null
  createdAt: string
  artifact?: {
    path: string
    sessionTemp: SessionTempPaths
    file?: FileHandle
    tail: Promise<void>
    captureError?: string
  }
}

export interface TerminalBackgroundSnapshot {
  terminalId: TerminalId
  status: TerminalStatus
  exitCode: number | null
  cursor: number
  artifactAvailable: boolean
  artifactPath?: string
  captureError?: string
  createdAt: string
}

export interface TerminalOutputRead {
  terminalId: TerminalId
  content: string
  cursor: number
  truncated: boolean
  totalBytes: number
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

function utf8SafeTail(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value
  let start = Math.max(0, value.byteLength - Math.max(0, maximumBytes))
  while (start < value.byteLength && (value[start] & 0xc0) === 0x80) {
    start += 1
  }
  return value.subarray(start)
}

/** Owns PTY terminal processes per Session, bounded scrollback, and cleanup state. */
export class TerminalPool {
  readonly #options: TerminalPoolOptions
  readonly #resources = new Map<TerminalId, TerminalResource>()
  readonly #closedOwners = new Map<TerminalId, SessionId>()
  readonly #closedBackground = new Map<
    TerminalId,
    {
      ownerSessionId: SessionId
      snapshot: TerminalBackgroundSnapshot
      output: TerminalOutputRead
    }
  >()
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
    ownerSessionId?: SessionId
    workspace: string
    sessionTemp?: SessionTempPaths
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
    ownerSessionId?: SessionId
    workspace: string
    sessionTemp?: SessionTempPaths
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const generation = this.#sessionGenerations.get(input.sessionId) ?? 0
    const guard = PathGuard.fromCanonical(
      input.workspace,
      input.sessionTemp?.root,
    )
    const guarded = await guard.resolveExisting(input.cwd ?? '.')
    const cwdStat = await stat(guarded.realPath)

    if (!cwdStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        'Terminal cwd is not a directory',
      )
    }

    const id = allocateTerminalId()
    const artifact = await this.#createArtifact(input.sessionTemp, id)
    let profile: CommandShellProfile
    let pty: PtyLike
    const cols = input.cols ?? 100
    const rows = input.rows ?? 30
    try {
      const selection = this.#options.getCommandShellSelection?.() ?? 'auto'
      profile = await this.#resolveShellProfile(selection)
      // Spawn through registration below is synchronous, so this single check
      // covers every await point where closeSession/dispose could interleave.
      this.#assertOpenStillValid(input.sessionId, generation)
      const shellArgs =
        profile.kind === 'powershell'
          ? [...POWERSHELL_PROCESS_EXECUTION_POLICY_ARGS]
          : []
      const environment = createCommandEnvironment(
        process.env,
        input.sessionTemp,
      )
      delete environment.NO_COLOR
      environment.TERM = 'xterm-256color'
      environment.COLORTERM = 'truecolor'
      const spawnPty = this.#options.spawnPty ?? nodePty.spawn
      pty = spawnPty(profile.executable, shellArgs, {
        name: 'xterm-256color',
        cwd: guarded.realPath,
        cols,
        rows,
        env: environment,
      })
    } catch (error) {
      await artifact?.file?.close().catch(() => undefined)
      throw error
    }
    const shell = profile.executable
    const info: TerminalInfo = {
      terminalId: id,
      cwd: path.resolve(guarded.realPath),
      shell,
      status: 'opening',
      cols,
      rows,
      seq: 0,
      artifactAvailable: Boolean(artifact?.file),
      ...(artifact?.file ? { artifactPath: artifact.path } : {}),
      ...(artifact?.captureError
        ? { captureError: artifact.captureError }
        : {}),
    }
    let resolveExit!: () => void
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const resource: TerminalResource = {
      info,
      sessionId: input.sessionId,
      ownerSessionId: input.ownerSessionId ?? input.sessionId,
      pty,
      scrollback: new ByteRingBuffer(this.#options.getScrollbackBytes()),
      modelScrollback: new ByteRingBuffer(this.#options.getScrollbackBytes()),
      sanitizer: new AnsiStreamSanitizer(),
      dataDisposable: { dispose: () => undefined },
      exitDisposable: { dispose: () => undefined },
      exitPromise,
      resolveExit,
      explicitClose: false,
      exitCode: null,
      createdAt: new Date().toISOString(),
      artifact,
    }
    this.#resources.set(id, resource)
    this.#emitStatus(resource, 'opening')
    resource.dataDisposable = pty.onData((chunk) => {
      resource.scrollback.append(chunk)
      this.#captureModelOutput(resource, chunk)
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
      resource.exitCode = exitCode
      resource.exitDisposable.dispose()
      if (!resource.explicitClose) {
        this.#emitStatus(resource, 'closed', exitCode)
      }
      void this.#finishArtifact(resource).finally(resource.resolveExit)
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

  /** Lists terminal task snapshots owned by one public Session. */
  listBackground(ownerSessionId: SessionId): TerminalBackgroundSnapshot[] {
    return [
      ...[...this.#resources.values()]
        .filter((resource) => resource.ownerSessionId === ownerSessionId)
        .map((resource) => this.#backgroundSnapshot(resource)),
      ...[...this.#closedBackground.values()]
        .filter((entry) => entry.ownerSessionId === ownerSessionId)
        .map((entry) => ({ ...entry.snapshot })),
    ].sort((left, right) => right.terminalId - left.terminalId)
  }

  /** Returns one public-Session-owned Terminal snapshot for background tools. */
  backgroundSnapshot(
    ownerSessionId: SessionId,
    id: TerminalId,
  ): TerminalBackgroundSnapshot {
    const resource = this.#resources.get(id)
    if (!resource) {
      const closed = this.#closedBackground.get(id)
      if (closed?.ownerSessionId === ownerSessionId) {
        return { ...closed.snapshot }
      }
      throw new Error('Terminal not found for this session')
    }
    if (resource.ownerSessionId !== ownerSessionId) {
      throw new Error('Terminal not found for this session')
    }
    return this.#backgroundSnapshot(resource)
  }

  /** Waits until one owned PTY exits. */
  waitForExit(ownerSessionId: SessionId, id: TerminalId): Promise<void> {
    const resource = this.#resources.get(id)
    if (!resource) {
      const closed = this.#closedBackground.get(id)
      return closed?.ownerSessionId === ownerSessionId
        ? Promise.resolve()
        : Promise.reject(new Error('Terminal not found for this session'))
    }
    if (resource.ownerSessionId !== ownerSessionId) {
      return Promise.reject(new Error('Terminal not found for this session'))
    }
    return resource.exitPromise
  }

  /** Cancels one Terminal task by its public owner. */
  cancelBackground(ownerSessionId: SessionId, id: TerminalId): boolean {
    const resource = this.#resources.get(id)
    if (!resource || resource.ownerSessionId !== ownerSessionId) return false
    void this.#disposeResource(resource)
    return true
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
  ): TerminalOutputRead {
    return this.#readResource(this.#requireOwned(sessionId, id), options)
  }

  /** Reads bounded model output from a Terminal owned by one public Session. */
  readBackground(
    ownerSessionId: SessionId,
    id: TerminalId,
    options: { cursor?: number; lines?: number; maxBytes: number },
  ): TerminalOutputRead {
    const resource = this.#resources.get(id)
    if (!resource) {
      const closed = this.#closedBackground.get(id)
      if (closed?.ownerSessionId === ownerSessionId) {
        return this.#boundOutputRead(closed.output, options)
      }
      throw new Error('Terminal not found for this session')
    }
    if (resource.ownerSessionId !== ownerSessionId) {
      throw new Error('Terminal not found for this session')
    }
    return this.#readResource(resource, options)
  }

  #readResource(
    resource: TerminalResource,
    options: { cursor?: number; lines?: number; maxBytes: number },
  ): TerminalOutputRead {
    const snapshot = resource.modelScrollback.snapshot(options.cursor)
    return this.#boundOutputRead(
      {
        terminalId: resource.info.terminalId,
        content: snapshot.data,
        cursor: snapshot.cursor,
        truncated: snapshot.truncated,
        totalBytes: snapshot.totalBytes,
      },
      options,
    )
  }

  #boundOutputRead(
    output: TerminalOutputRead,
    options: { lines?: number; maxBytes: number },
  ): TerminalOutputRead {
    let content = output.content
    const lines = Math.max(1, options.lines ?? 200)
    const endsWithNewline = /\r?\n$/u.test(content)
    const split = content.split(/\r?\n/u)
    if (endsWithNewline) split.pop()

    if (split.length > lines) {
      content = `${split.slice(-lines).join('\n')}${endsWithNewline ? '\n' : ''}`
    }

    const encoded = Buffer.from(content)
    const bounded = utf8SafeTail(encoded, options.maxBytes)

    return {
      terminalId: output.terminalId,
      content: bounded.toString('utf8'),
      cursor: output.cursor,
      truncated:
        output.truncated ||
        split.length > lines ||
        encoded.byteLength > options.maxBytes,
      totalBytes: output.totalBytes,
    }
  }

  /** Returns the ANSI-free model-output cursor used by terminal_send. */
  modelCursor(sessionId: SessionId, id: TerminalId): number {
    return this.#requireOwned(sessionId, id).modelScrollback.snapshot().cursor
  }

  /** Reads output after a cursor, falling back to a short tail when no new text arrived. */
  readDeltaOrTail(
    sessionId: SessionId,
    id: TerminalId,
    cursor: number,
    options: { lines: number; maxBytes: number },
  ): ReturnType<TerminalPool['read']> & { delta: boolean } {
    const delta = this.read(sessionId, id, {
      cursor,
      lines: options.lines,
      maxBytes: options.maxBytes,
    })
    if (delta.content) return { ...delta, delta: true }
    return {
      ...this.read(sessionId, id, {
        lines: options.lines,
        maxBytes: options.maxBytes,
      }),
      delta: false,
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

    const waitController = new AbortController()
    try {
      await Promise.race([
        Promise.allSettled(pending),
        delay(1_000, waitController.signal),
      ])
    } finally {
      waitController.abort()
    }
  }

  #requireOwned(sessionId: SessionId, id: TerminalId): TerminalResource {
    const resource = this.#resources.get(id)

    if (!resource || resource.sessionId !== sessionId) {
      throw new Error('Terminal not found for this session')
    }

    return resource
  }

  async #createArtifact(
    sessionTemp: SessionTempPaths | undefined,
    id: TerminalId,
  ): Promise<TerminalResource['artifact']> {
    if (!sessionTemp) return undefined
    const directory = path.join(sessionTemp.artifacts, 'terminals')
    const artifactPath = path.join(directory, `terminal-${id}.log`)
    let file: FileHandle | undefined
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(directory, 0o700)
      file = await open(artifactPath, 'w', 0o600)
      if (process.platform !== 'win32') await file.chmod(0o600)
      return {
        path: artifactPath,
        sessionTemp,
        file,
        tail: Promise.resolve(),
      }
    } catch (error) {
      await file?.close().catch(() => undefined)
      return {
        path: artifactPath,
        sessionTemp,
        tail: Promise.resolve(),
        captureError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  #captureModelOutput(resource: TerminalResource, chunk: string): void {
    const sanitized = resource.sanitizer.push(chunk)
    if (!sanitized) return
    resource.modelScrollback.append(sanitized)
    this.#queueArtifactText(resource, sanitized)
  }

  #queueArtifactText(resource: TerminalResource, text: string): void {
    const artifact = resource.artifact
    if (!artifact || artifact.captureError || !artifact.file || !text) return
    artifact.tail = artifact.tail
      .then(async () => {
        await artifact.file!.write(text, undefined, 'utf8')
      })
      .catch((error: unknown) => {
        artifact.captureError =
          error instanceof Error ? error.message : String(error)
        resource.info.artifactAvailable = false
        delete resource.info.artifactPath
        resource.info.captureError = artifact.captureError
      })
  }

  async #finishArtifact(resource: TerminalResource): Promise<void> {
    const artifact = resource.artifact
    const suffix = resource.sanitizer.flush()
    if (suffix) {
      resource.modelScrollback.append(suffix)
      this.#queueArtifactText(resource, suffix)
    }
    if (!artifact) return
    await artifact.tail.catch(() => undefined)
    await artifact.file?.close().catch((error: unknown) => {
      artifact.captureError ??=
        error instanceof Error ? error.message : String(error)
    })
    await touchSessionTempPath(artifact.sessionTemp).catch((error: unknown) => {
      artifact.captureError ??=
        error instanceof Error ? error.message : String(error)
    })
    if (artifact.captureError) {
      resource.info.artifactAvailable = false
      delete resource.info.artifactPath
      resource.info.captureError = artifact.captureError
    }
    const closed = this.#closedBackground.get(resource.info.terminalId)
    if (closed) {
      closed.snapshot = {
        ...closed.snapshot,
        artifactAvailable: Boolean(artifact.file && !artifact.captureError),
        ...(artifact.file && !artifact.captureError
          ? { artifactPath: artifact.path }
          : { artifactPath: undefined }),
        ...(artifact.captureError
          ? { captureError: artifact.captureError }
          : { captureError: undefined }),
      }
    }
  }

  #backgroundSnapshot(resource: TerminalResource): TerminalBackgroundSnapshot {
    const cursor = resource.modelScrollback.snapshot().cursor
    const artifact = resource.artifact
    return {
      terminalId: resource.info.terminalId,
      status: resource.info.status,
      exitCode: resource.exitCode,
      cursor,
      artifactAvailable: Boolean(artifact?.file && !artifact.captureError),
      ...(artifact?.file && !artifact.captureError
        ? { artifactPath: artifact.path }
        : {}),
      ...(artifact?.captureError
        ? { captureError: artifact.captureError }
        : {}),
      createdAt: resource.createdAt,
    }
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
    const closedSnapshot = this.#backgroundSnapshot(resource)
    const closedOutput = this.#readResource(resource, {
      lines: TERMINAL_BACKGROUND_TAIL_LINES,
      maxBytes: TERMINAL_BACKGROUND_TAIL_BYTES,
    })
    resource.scrollback.clear()
    resource.modelScrollback.clear()
    this.#resources.delete(resource.info.terminalId)
    this.#closedOwners.set(resource.info.terminalId, resource.sessionId)
    this.#closedBackground.set(resource.info.terminalId, {
      ownerSessionId: resource.ownerSessionId,
      snapshot: closedSnapshot,
      output: closedOutput,
    })

    if (this.#closedOwners.size > 256) {
      const oldest = this.#closedOwners.keys().next().value!
      this.#closedOwners.delete(oldest)
      this.#closedBackground.delete(oldest)
    }

    const pending = resource.exitPromise.finally(() => {
      resource.exitDisposable.dispose()
      this.#pendingExits.delete(pending)
    })
    this.#pendingExits.add(pending)
    return pending
  }
}
