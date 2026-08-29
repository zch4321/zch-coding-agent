import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../../shared/ids'
import type {
  CommandShellProfile,
  CommandShellProfileId,
  CommandShellSelection,
} from '../../shared/command-shell'
import type { PtyLike, TerminalEventDraft, TerminalPoolOptions } from './pool'
import { MAX_TERMINALS_PER_SESSION, TerminalPool } from './pool'

class FakePty implements PtyLike {
  readonly pid = 123
  readonly writes: string[] = []
  readonly sizes: Array<[number, number]> = []
  killed = false
  #data = new Set<(data: string) => void>()
  #exit = new Set<(event: { exitCode: number; signal?: number }) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(columns: number, rows: number): void {
    this.sizes.push([columns, rows])
  }

  kill(): void {
    this.killed = true
    for (const listener of this.#exit) {
      listener({ exitCode: 0 })
    }
  }

  onData(listener: (data: string) => void) {
    this.#data.add(listener)
    return { dispose: () => this.#data.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#exit.add(listener)
    return { dispose: () => this.#exit.delete(listener) }
  }

  emitData(data: string): void {
    for (const listener of this.#data) {
      listener(data)
    }
  }

  emitExit(exitCode = 0): void {
    for (const listener of this.#exit) {
      listener({ exitCode })
    }
  }
}

const sessionA = 'session:a' as SessionId
const sessionB = 'session:b' as SessionId

const PROFILE_KINDS: Record<
  CommandShellProfileId,
  CommandShellProfile['kind']
> = {
  'powershell-7': 'powershell',
  'windows-powershell': 'powershell',
  cmd: 'cmd',
  'git-bash': 'bash',
  nushell: 'nushell',
  'system-shell': 'posix',
}

/** Builds a deterministic resolved profile for a selection, mirroring the real discovery kinds. */
function fakeProfile(selection: CommandShellSelection): CommandShellProfile {
  const id: CommandShellProfileId =
    selection === 'auto' ? 'system-shell' : selection
  return {
    id,
    kind: PROFILE_KINDS[id],
    label: id,
    executable: `/fake/${id}`,
    source: 'system',
  }
}

async function harness(
  scrollbackBytes = 1_024,
  options: {
    selectShell?: () => CommandShellSelection
    resolveShellProfile?: TerminalPoolOptions['resolveShellProfile']
    spawnPty?: (shell: string, args: string[]) => PtyLike
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-terminal-'))
  const events: TerminalEventDraft[] = []
  const ptys: FakePty[] = []
  const launches: Array<{ shell: string; args: string[] }> = []
  const selections: CommandShellSelection[] = []
  const pool = new TerminalPool({
    getScrollbackBytes: () => scrollbackBytes,
    emit: (event) => events.push(event),
    ...(options.selectShell
      ? { getCommandShellSelection: options.selectShell }
      : {}),
    resolveShellProfile: async (selection) => {
      selections.push(selection)
      return options.resolveShellProfile
        ? options.resolveShellProfile(selection)
        : fakeProfile(selection)
    },
    spawnPty: (shell, args) => {
      launches.push({ shell, args: [...args] })
      const pty = options.spawnPty?.(shell, args) ?? new FakePty()
      if (pty instanceof FakePty) ptys.push(pty)
      return pty
    },
  })
  return { root, events, launches, ptys, selections, pool }
}

describe('TerminalPool', () => {
  it('waits for active PTYs to exit during disposal', async () => {
    const { root, ptys, pool } = await harness()
    await pool.open({ sessionId: sessionA, workspace: root })

    await pool.dispose()

    expect(ptys[0]?.killed).toBe(true)
    expect(pool.list(sessionA)).toEqual([])
  })

  it('streams ANSI output but returns bounded ANSI-free model text', async () => {
    const { root, events, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })
    ptys[0]!.emitData('\u001b[31mred\u001b[0m\nnext')

    expect(
      events.some(
        (event) =>
          event.type === 'terminal.output' &&
          event.chunk?.includes('\u001b[31m'),
      ),
    ).toBe(true)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(
      pool.read(sessionA, terminal.terminalId, {
        lines: 2,
        maxBytes: 1_024,
      }),
    ).toMatchObject({
      content: 'red\nnext',
      truncated: false,
    })
  })

  it('reads background output through the public owner Session', async () => {
    const { root, ptys, pool } = await harness()
    const terminal = await pool.open({
      sessionId: sessionA,
      ownerSessionId: sessionB,
      workspace: root,
    })
    ptys[0]!.emitData('child terminal output\n')

    expect(
      pool.readBackground(sessionB, terminal.terminalId, {
        cursor: 0,
        lines: 500,
        maxBytes: 256 * 1_024,
      }),
    ).toMatchObject({ content: 'child terminal output\n' })
    expect(() =>
      pool.readBackground(sessionA, terminal.terminalId, {
        cursor: 0,
        lines: 500,
        maxBytes: 256 * 1_024,
      }),
    ).toThrow('Terminal not found for this session')

    ptys[0]!.emitData('前🙂后')
    expect(
      pool.readBackground(sessionB, terminal.terminalId, {
        lines: 500,
        maxBytes: 6,
      }).content,
    ).toBe('后')
  })

  it('writes a complete ANSI-free artifact across chunk boundaries', async () => {
    const { root, ptys, pool } = await harness()
    const sessionTemp = {
      root: path.join(root, 'session-temp'),
      artifacts: path.join(root, 'session-temp', 'artifacts'),
      scratch: path.join(root, 'session-temp', 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const terminal = await pool.open({
      sessionId: sessionA,
      workspace: root,
      sessionTemp,
    })
    ptys[0]!.emitData('\u001b]0;npm run lint')
    expect(
      pool.read(sessionA, terminal.terminalId, {
        lines: 20,
        maxBytes: 8 * 1_024,
      }).content,
    ).toBe('')
    ptys[0]!.emitData('\u0007visible\n\u001b]0;C:\\workspace\\app\u001b')
    ptys[0]!.emitData('\\\u001b[31mred\u001b[0m\nplain')
    expect(
      pool.read(sessionA, terminal.terminalId, {
        lines: 20,
        maxBytes: 8 * 1_024,
      }).content,
    ).toBe('visible\nred\nplain')
    ptys[0]!.emitExit(0)
    await pool.waitForExit(sessionA, terminal.terminalId)

    expect(terminal).toMatchObject({
      artifactAvailable: true,
      artifactPath: expect.any(String),
    })
    expect(await readFile(terminal.artifactPath!, 'utf8')).toBe(
      'visible\nred\nplain',
    )
  })

  it('keeps the PTY usable while reporting artifact initialization failure', async () => {
    const { root, ptys, pool } = await harness()
    const blockedArtifacts = path.join(root, 'blocked-artifacts')
    await writeFile(blockedArtifacts, 'not a directory')
    const terminal = await pool.open({
      sessionId: sessionA,
      workspace: root,
      sessionTemp: {
        root: path.join(root, 'session-temp'),
        artifacts: blockedArtifacts,
        scratch: path.join(root, 'session-temp', 'scratch'),
      },
    })

    expect(terminal).toMatchObject({
      status: 'running',
      artifactAvailable: false,
      captureError: expect.any(String),
    })
    expect(terminal).not.toHaveProperty('artifactPath')
    expect(pool.write(sessionA, terminal.terminalId, 'echo usable\n')).toBe(
      true,
    )
    expect(ptys[0]?.writes).toEqual(['echo usable\n'])
  })

  it('rejects cross-session access and closes all session terminals', async () => {
    const { root, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })

    expect(() => pool.write(sessionB, terminal.terminalId, 'whoami\r')).toThrow(
      'Terminal not found for this session',
    )
    expect(pool.write(sessionA, terminal.terminalId, 'whoami\r')).toBe(true)
    expect(ptys[0]!.writes).toEqual(['whoami\r'])

    pool.closeSession(sessionA)
    expect(ptys[0]!.killed).toBe(true)
    expect(pool.list(sessionA)).toEqual([])
    expect(pool.close(sessionA, terminal.terminalId)).toBe(false)
  })

  it('resizes an owned running terminal', async () => {
    const { root, ptys, pool } = await harness()
    const terminal = await pool.open({ sessionId: sessionA, workspace: root })

    expect(pool.resize(sessionA, terminal.terminalId, 120, 40)).toBe(true)
    expect(ptys[0]!.sizes).toEqual([[120, 40]])
  })

  it('uses the supplied PTY factory without invoking native spawn', async () => {
    const { root, pool } = await harness()
    const open = vi.spyOn(pool, 'open')
    await pool.open({ sessionId: sessionA, workspace: root })
    expect(open).toHaveBeenCalledOnce()
  })

  it('resolves the configured shell profile for each new terminal', async () => {
    const { root, launches, selections, pool } = await harness(1_024, {
      selectShell: () => 'git-bash',
    })

    await pool.open({ sessionId: sessionA, workspace: root })

    expect(selections).toEqual(['git-bash'])
    expect(launches).toEqual([{ shell: '/fake/git-bash', args: [] }])
  })

  it('passes PowerShell execution policy args for resolved PowerShell profiles', async () => {
    const { root, launches, pool } = await harness(1_024, {
      selectShell: () => 'powershell-7',
    })

    await pool.open({ sessionId: sessionA, workspace: root })

    expect(launches).toEqual([
      { shell: '/fake/powershell-7', args: ['-ExecutionPolicy', 'Bypass'] },
    ])
  })

  it('reads the current selection on every open so settings changes apply to later terminals', async () => {
    let current: CommandShellSelection = 'cmd'
    const { root, launches, selections, pool } = await harness(1_024, {
      selectShell: () => current,
    })

    await pool.open({ sessionId: sessionA, workspace: root })
    current = 'nushell'
    await pool.open({ sessionId: sessionA, workspace: root })

    expect(selections).toEqual(['cmd', 'nushell'])
    expect(launches.map((launch) => launch.shell)).toEqual([
      '/fake/cmd',
      '/fake/nushell',
    ])
  })

  it('defaults to the automatic selection when no getter is configured', async () => {
    const { root, selections, pool } = await harness()

    await pool.open({ sessionId: sessionA, workspace: root })

    expect(selections).toEqual(['auto'])
  })

  it('allocates monotonically increasing ids across sessions without reuse', async () => {
    const { root, pool } = await harness()
    const first = await pool.open({ sessionId: sessionA, workspace: root })
    const second = await pool.open({ sessionId: sessionB, workspace: root })

    expect(second.terminalId).toBeGreaterThan(first.terminalId)

    expect(pool.close(sessionA, first.terminalId)).toBe(true)
    const reopened = await pool.open({ sessionId: sessionA, workspace: root })
    expect(reopened.terminalId).toBeGreaterThan(second.terminalId)
  })

  it('lists terminals sorted by ascending numeric id', async () => {
    const { root, pool } = await harness()
    const opened = []
    for (let index = 0; index < 3; index += 1) {
      opened.push(await pool.open({ sessionId: sessionA, workspace: root }))
    }

    const listed = pool.list(sessionA).map((terminal) => terminal.terminalId)
    expect(listed).toEqual(opened.map((terminal) => terminal.terminalId))
    expect([...listed].sort((left, right) => left - right)).toEqual(listed)
  })

  it('rejects the terminal beyond the per-session limit until one is closed', async () => {
    const { root, pool } = await harness()
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await pool.open({ sessionId: sessionA, workspace: root })
    }

    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('Session terminal limit reached')

    // Other Sessions still have their own quota.
    await expect(
      pool.open({ sessionId: sessionB, workspace: root }),
    ).resolves.toMatchObject({ status: 'running' })

    const [oldest] = pool.list(sessionA)
    expect(pool.close(sessionA, oldest!.terminalId)).toBe(true)
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).resolves.toMatchObject({ status: 'running' })
    expect(pool.list(sessionA)).toHaveLength(MAX_TERMINALS_PER_SESSION)
  })

  it('counts self-exited terminals until they are explicitly closed', async () => {
    const { root, ptys, pool } = await harness()
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await pool.open({ sessionId: sessionA, workspace: root })
    }
    ptys[0]!.emitExit(0)

    expect(pool.list(sessionA)[0]?.status).toBe('closed')
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('Session terminal limit reached')

    expect(pool.close(sessionA, pool.list(sessionA)[0]!.terminalId)).toBe(true)
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).resolves.toMatchObject({ status: 'running' })
  })

  it('releases the reservation when startup fails', async () => {
    let failures = 1
    const { root, pool } = await harness(1_024, {
      spawnPty: () => {
        if (failures > 0) {
          failures -= 1
          throw new Error('spawn failed')
        }
        return new FakePty()
      },
    })

    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('spawn failed')

    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await pool.open({ sessionId: sessionA, workspace: root })
    }
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('Session terminal limit reached')
  })

  it('does not allow concurrent opens to bypass the limit', async () => {
    const { root, pool } = await harness()
    const attempts = Array.from({ length: MAX_TERMINALS_PER_SESSION + 4 }, () =>
      pool.open({ sessionId: sessionA, workspace: root }).then(
        (info) => info,
        (error: unknown) => error,
      ),
    )

    const results = await Promise.all(attempts)
    const opened = results.filter((result) => !(result instanceof Error))
    const rejected = results.filter((result) => result instanceof Error)

    expect(opened).toHaveLength(MAX_TERMINALS_PER_SESSION)
    expect(rejected).toHaveLength(4)
    for (const error of rejected) {
      expect((error as Error).message).toContain(
        'Session terminal limit reached',
      )
    }
    expect(pool.list(sessionA)).toHaveLength(MAX_TERMINALS_PER_SESSION)
  })

  it('rejects an open that finishes after its Session was closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { root, ptys, pool } = await harness(1_024, {
      resolveShellProfile: async (selection) => {
        await gate
        return fakeProfile(selection)
      },
    })

    const pending = pool.open({ sessionId: sessionA, workspace: root })
    pool.closeSession(sessionA)
    release()

    await expect(pending).rejects.toThrow(
      'Session closed while the terminal was starting',
    )
    expect(ptys).toHaveLength(0)
    expect(pool.list(sessionA)).toEqual([])

    // A later open for the same Session id (Session reopened) still works.
    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).resolves.toMatchObject({ status: 'running' })
  })

  it('rejects an open that finishes after the pool was disposed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { root, ptys, pool } = await harness(1_024, {
      resolveShellProfile: async (selection) => {
        await gate
        return fakeProfile(selection)
      },
    })

    const pending = pool.open({ sessionId: sessionA, workspace: root })
    const disposed = pool.dispose()
    release()

    await expect(pending).rejects.toThrow('Terminal pool is disposed')
    await disposed
    expect(ptys).toHaveLength(0)
  })

  it('rejects new opens after disposal', async () => {
    const { root, pool } = await harness()
    await pool.dispose()

    await expect(
      pool.open({ sessionId: sessionA, workspace: root }),
    ).rejects.toThrow('Terminal pool is disposed')
  })
})
