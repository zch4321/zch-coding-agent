import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import {
  createTestDatabase,
  type TestDatabase,
} from '../persistence/test-database'
import { ProjectRepository } from '../persistence/project-repository'
import { ProjectArtifactRepository } from '../persistence/project-artifact-repository'
import { SessionRepository } from '../persistence/session-repository'
import {
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import {
  SessionTempService,
  desktopSessionTempRoot,
  writeSessionArtifactText,
} from '../session-temp/service'
import {
  resolveSessionTempToolPath,
  projectFileToolPaths,
} from '../session-temp/path-alias'
import { registerReadOnlyTools } from '../tools/readonly-tools'
import { registerFileTools } from '../tools/file-tools'
import { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import type { ToolCall } from '../tools/types'
import { PathGuard } from '../safety/path-guard'
import { runCommand } from '../process/run'
import { artifactPathFor, finishArtifact } from './access'
import { ProjectArtifactService } from './service'
import { createTerminalHarness } from '../terminal/terminal-test-support'
import { readTerminalArtifactTail } from '../terminal/artifact-tail'

const day = 24 * 60 * 60_000
const first = 'session:first' as SessionId
const second = 'session:second' as SessionId
let testDatabase: TestDatabase
let services: ProjectArtifactService[] = []
let legacyRoot: string
let nativeBase: string
let workspace: string
let now = 1_000_000

async function setup() {
  testDatabase = await createTestDatabase()
  workspace = path.join(testDatabase.directory, '项目 workspace')
  await mkdir(workspace)
  workspace = await realpath(workspace)
  nativeBase = path.join(testDatabase.directory, 'short')
  legacyRoot = desktopSessionTempRoot(testDatabase.directory)
  now = 1_000_000
  const project = projectFixture({ path: workspace })
  await testDatabase.database.withTransaction((tx) => {
    new ProjectRepository().insert(tx, project)
    for (const id of [first, second])
      new SessionRepository().insert(tx, sessionFixture({ id, lastSeq: 0 }))
  })
  return project
}

async function service() {
  const result = new ProjectArtifactService({
    database: testDatabase.database,
    profileDirectory: testDatabase.directory,
    rootDirectory: nativeBase,
    now: () => now,
  })
  services.push(result)
  await result.initialize()
  return result
}

afterEach(async () => {
  for (const entry of services) await entry.dispose()
  services = []
  await testDatabase?.dispose()
  if (legacyRoot) await rm(legacyRoot, { recursive: true, force: true })
})

describe('native project captures', () => {
  it.each(['running', 'exited', 'closed'] as const)(
    'pins the registered root when previewing a %s terminal',
    async (status) => {
      await setup()
      const original = path.join(testDatabase.directory, 'storage')
      const entry = path.join(testDatabase.directory, 'temp-entry')
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      await mkdir(original)
      await symlink(original, entry, linkType)
      nativeBase = path.join(entry, 'short')
      const manager = await service()
      const paths = await manager.ensureSession(first)
      const terminal = await createTerminalHarness()
      let replaced = false
      try {
        const opened = await terminal.pool.open({
          sessionId: first,
          workspace,
          sessionTemp: paths,
        })
        terminal.ptys[0]!.emitData('original terminal output\n')
        if (status === 'closed')
          terminal.pool.cancelBackground(first, opened.terminalId)
        if (status !== 'running') {
          terminal.ptys[0]!.emitExit()
          await terminal.pool.waitForSessionExit(first)
        }
        const artifact = terminal.pool.backgroundArtifact(
          first,
          opened.terminalId,
        )!
        expect(artifact.canonicalRoot).toBe(paths.canonicalRoot)
        await expect
          .poll(async () => (await readTerminalArtifactTail(artifact)).content)
          .toContain('original terminal output')
        const outside = path.join(testDatabase.directory, 'outside')
        const outsideFile = path.join(
          outside,
          path.relative(entry, artifact.path),
        )
        await mkdir(path.dirname(outsideFile), { recursive: true })
        await writeFile(outsideFile, 'outside content\n')
        // Retarget the entry without renaming a live log directory, which Windows locks.
        await unlink(entry)
        replaced = true
        await symlink(outside, entry, linkType)
        const refreshed = terminal.pool.backgroundArtifact(
          first,
          opened.terminalId,
        )!
        await expect(readTerminalArtifactTail(refreshed)).rejects.toMatchObject(
          { code: 'RESOURCE_CHANGED' },
        )
      } finally {
        if (replaced) {
          await rm(entry, { force: true, recursive: true })
          await symlink(original, entry, linkType)
        }
        await terminal.dispose()
      }
    },
  )

  it('shares one real path across Sessions, process args, cwd and guarded reads without rewriting text', async () => {
    await setup()
    const manager = await service()
    const a = await manager.ensureSession(first)
    const b = await manager.ensureSession(second)
    expect(a.root).toBe(b.root)
    expect(await realpath(a.workspaceAlias!)).toBe(workspace)
    const result = await runCommand({
      workspace,
      sessionTemp: a,
      artifactKey: 'long-uuid-call',
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('complete output')"],
        cwd: a.workspaceAlias,
      },
      timeoutMs: 5_000,
      maxOutputBytes: 8,
      signal: new AbortController().signal,
    })
    expect(result.artifactPath).toBe(path.join(a.artifacts, 'commands', '1'))
    expect(result.truncated).toBe(true)
    const log = path.join(result.artifactPath!, 'stdout.log')
    const guard = PathGuard.fromCanonical(workspace, b.root, b.workspaceAlias)
    expect(
      await readFile((await guard.resolveExisting(log)).realPath, 'utf8'),
    ).toBe('complete output')
    const reader = await runCommand({
      workspace,
      sessionTemp: b,
      artifactKey: 'read-from-other-session',
      command: {
        mode: 'process',
        executable: process.execPath,
        args: [
          '-e',
          "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
          log,
        ],
        cwd: b.scratch,
      },
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    })
    expect(reader.stdout).toBe('complete output')
    expect(reader.artifactPath).toBe(path.join(a.artifacts, 'commands', '2'))
    expect(
      projectFileToolPaths(
        { path: path.join(workspace, 'x'), text: workspace },
        a,
        workspace,
      ),
    ).toEqual({ path: path.join(a.workspaceAlias!, 'x'), text: workspace })
    await manager.removeSession(first)
    expect(await readFile(log, 'utf8')).toBe('complete output')
    const exported = JSON.parse(
      await readFile(
        await manager.exportSession(
          second,
          path.join(testDatabase.directory, 'export'),
        ),
        'utf8',
      ),
    )
    expect(exported.captures.map((entry: { id: number }) => entry.id)).toEqual([
      2,
    ])
  })

  it('accepts the same native paths through real file-tool authorization and preserves artifact write restrictions', async () => {
    await setup()
    const manager = await service()
    const a = await manager.ensureSession(first)
    const b = await manager.ensureSession(second)
    const file = await writeSessionArtifactText(
      a,
      ['commands', 'producer', 'stdout.log'],
      'searchable output',
    )
    const registry = new ToolRegistry()
    registerReadOnlyTools(registry)
    registerFileTools(registry)
    const executor = new ToolExecutor(registry)
    const execute = async (toolId: string, args: ToolCall['args']) => {
      const call = { id: `call:${toolId}` as CallId, toolId, args, reason: '' }
      const definition = registry.get(toolId)!
      const signal = new AbortController().signal
      const common = {
        sessionId: second,
        runId: 'run:reader' as RunId,
        sessionTemp: b,
      }
      const authorized = await new PermissionPipeline().authorize({
        ...common,
        workspace,
        mode: 'yolo',
        call,
        definition,
        config: toPublicConfig(DEFAULT_APP_CONFIG, false),
        signal,
        requestHumanApproval: async () => ({ decision: 'deny' }),
      })
      return authorized.ok
        ? executor.execute(
            authorized.approvedCall,
            { ...common, workspace: { canonicalPath: workspace } },
            signal,
          )
        : authorized.result
    }
    for (const [toolId, args] of [
      ['read_file', { path: file }],
      ['list_dir', { path: path.dirname(file) }],
      ['glob', { path: b.artifacts, pattern: '**/*.log' }],
      ['grep', { path: b.artifacts, pattern: 'searchable' }],
      [
        'write_file',
        {
          path: path.join(b.workspaceAlias!, 'from-tool'),
          content: 'workspace',
        },
      ],
      [
        'write_file',
        { path: path.join(b.scratch, 'from-tool'), content: 'scratch' },
      ],
    ] as Array<[string, ToolCall['args']]>) {
      const outcome = await execute(toolId, args)
      expect(outcome, JSON.stringify({ toolId, outcome })).toMatchObject({
        status: 'ok',
      })
    }
    expect(
      await execute('write_file', { path: file, content: 'overwrite' }),
    ).toMatchObject({ status: 'error' })
    expect(await readFile(file, 'utf8')).toBe('searchable output')
    const savedTmp = `${b.root}.saved`
    const fs = await import('node:fs/promises')
    await fs.rename(b.root, savedTmp)
    await symlink(
      workspace,
      b.root,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    try {
      expect(
        await execute('read_file', { path: path.join(b.root, 'from-tool') }),
      ).toMatchObject({ status: 'error' })
    } finally {
      await unlink(b.root)
      await fs.rename(savedTmp, b.root)
    }
  })

  it('keeps active captures and scratch, starts TTL at writer finalization, and never reuses collected IDs', async () => {
    await setup()
    const manager = await service()
    const a = await manager.ensureSession(first)
    const old = await writeSessionArtifactText(
      a,
      ['commands', 'old', 'stdout.log'],
      'old',
    )
    const active = await writeSessionArtifactText(
      a,
      ['commands', 'active', 'stdout.log'],
      'active',
    )
    await writeFile(path.join(a.scratch, 'keep'), 'scratch')
    await finishArtifact(a, ['commands', 'old'])
    now += day - 1
    await manager.touch(first)
    await manager.collect()
    expect(await readFile(old, 'utf8')).toBe('old')
    now += 2
    await readFile(old)
    await manager.ensureSession(second)
    await manager.collect()
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(active, 'utf8')).toBe('active')
    expect(await readFile(path.join(a.scratch, 'keep'), 'utf8')).toBe('scratch')
    await manager.dispose()
    const restarted = await service()
    const b = await restarted.ensureSession(second)
    expect(b.root).toBe(a.root)
    expect(await artifactPathFor(b, ['commands', 'next'])).toBe(
      path.join(a.artifacts, 'commands', '3'),
    )
    now += day + 1
    await restarted.collect()
    await expect(readFile(active)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allocates atomic per-kind IDs and separates restart Terminal handles from capture IDs', async () => {
    await setup()
    let manager = await service()
    const a = await manager.ensureSession(first)
    const paths = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        artifactPathFor(a, ['commands', `source-${index}`]),
      ),
    )
    expect(new Set(paths).size).toBe(20)
    expect(await artifactPathFor(a, ['commands', 'source-0'])).toBe(paths[0])
    expect(await artifactPathFor(a, ['terminals', 'terminal-1.log'])).toBe(
      path.join(a.artifacts, 'terminals', '1.log'),
    )
    await manager.dispose()
    manager = await service()
    const b = await manager.ensureSession(first)
    expect(await artifactPathFor(b, ['terminals', 'terminal-1.log'])).toBe(
      path.join(a.artifacts, 'terminals', '2.log'),
    )
  })

  it('rejects replaced workspace entries, capture ancestors, and cleanup paths without touching outside files', async () => {
    await setup()
    const manager = await service()
    const a = await manager.ensureSession(first)
    const outside = await mkdtemp(path.join(os.tmpdir(), 'zch-outside-'))
    try {
      await writeFile(path.join(outside, 'sentinel'), 'keep')
      await unlink(a.workspaceAlias!)
      await symlink(
        outside,
        a.workspaceAlias!,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      expect(() =>
        PathGuard.fromCanonical(workspace, a.root, a.workspaceAlias),
      ).toThrow()
      await expect(manager.ensureSession(first)).rejects.toThrow('replaced')
      await unlink(a.workspaceAlias!)
      await symlink(
        workspace,
        a.workspaceAlias!,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      const captured = await writeSessionArtifactText(
        a,
        ['commands', 'x', 'stdout.log'],
        'owned',
      )
      await finishArtifact(a, ['commands', 'x'])
      await rm(path.dirname(path.dirname(captured)), { recursive: true })
      await symlink(
        outside,
        path.join(a.artifacts, 'commands'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await expect(artifactPathFor(a, ['commands', 'new'])).rejects.toThrow(
        'real directory',
      )
      now += day + 1
      await manager.collect()
      expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe(
        'keep',
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('migrates legacy captures and scratch, disambiguates fork aliases, and collects compatibility copies', async () => {
    const project = await setup()
    const legacy = new SessionTempService({ rootDirectory: legacyRoot })
    for (const id of [first, second])
      await legacy.writeText(id, ['terminals', 'terminal-1.log'], id)
    const old = legacy.pathsFor(first)
    await writeFile(path.join(old.scratch, 'note'), 'before')
    const manager = await service()
    const a = await manager.ensureSession(first)
    const native = resolveSessionTempToolPath(
      'ZCH_SESSION_ARTIFACTS_DIR:/terminals/terminal-1.log',
      a,
    )
    expect(await readFile(native, 'utf8')).toBe(first)
    expect(
      await readFile(
        path.join(old.artifacts, 'terminals', 'terminal-1.log'),
        'utf8',
      ),
    ).toBe(first)
    const scratch = resolveSessionTempToolPath(
      'ZCH_SESSION_SCRATCH_DIR:/note',
      a,
    )
    await writeFile(scratch, 'after')
    expect(await readFile(path.join(old.scratch, 'note'), 'utf8')).toBe('after')
    const fork = await manager.ensureSession(second, {
      projectId: project.id,
      workspace,
      sourceSessionId: first,
    })
    expect(() =>
      resolveSessionTempToolPath(
        'ZCH_SESSION_ARTIFACTS_DIR:/terminals/terminal-1.log',
        fork,
      ),
    ).toThrow('AMBIGUOUS_LEGACY_PATH')
    expect(resolveSessionTempToolPath(native, fork)).toBe(native)
    now += day + 1
    await manager.collect()
    await expect(readFile(native)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(path.join(old.artifacts, 'terminals', 'terminal-1.log')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(scratch, 'utf8')).toBe('after')
  })

  it('resumes a registered migration after a copy was installed and before its transaction completed', async () => {
    await setup()
    const legacy = new SessionTempService({ rootDirectory: legacyRoot })
    const old = await legacy.writeText(
      first,
      ['commands', 'old-call', 'stdout.log'],
      'retained',
    )
    let manager = await service()
    let a = await manager.ensureSession(first)
    const repo = new ProjectArtifactRepository()
    const native = resolveSessionTempToolPath(old, a)
    await testDatabase.database.withTransaction((tx) =>
      tx
        .prepare(
          "UPDATE project_artifact_legacy_paths SET state = 'pending' WHERE relative_path LIKE 'artifacts/commands/%'",
        )
        .run(),
    )
    await manager.dispose()
    manager = await service()
    a = await manager.ensureSession(first)
    expect(resolveSessionTempToolPath(old, a)).toBe(native)
    expect(await readFile(native, 'utf8')).toBe('retained')
    expect(
      testDatabase.database
        .read((reader) => repo.owned(reader, a.projectId!, first))
        .map((record) => record.id),
    ).toEqual([1])
    expect(
      testDatabase.database
        .read((reader) => repo.legacy(reader, a.projectId!))
        .every((mapping) => mapping.state === 'ready'),
    ).toBe(true)
  })

  it('retries removed-project cleanup at startup without deleting its workspace', async () => {
    const project = await setup()
    const manager = await service()
    const a = await manager.ensureSession(first)
    await writeSessionArtifactText(a, ['fetch', 'one', 'result.json'], '{}')
    await writeFile(path.join(workspace, 'keep'), 'workspace')
    await testDatabase.database.withTransaction((tx) =>
      new ProjectRepository().delete(tx, project.id),
    )
    await manager.dispose()
    await service()
    await expect(
      readFile(path.join(a.artifacts, 'fetch', '1', 'result.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(workspace, 'keep'), 'utf8')).toBe(
      'workspace',
    )
    expect(
      testDatabase.database.read((reader) =>
        new ProjectArtifactRepository().root(reader, project.id),
      ),
    ).toBeUndefined()
  })
})
