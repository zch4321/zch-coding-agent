import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { Attachment } from '../../shared/attachments'
import { attachmentPart } from '../../shared/attachments'
import type { RunId } from '../../shared/ids'
import * as filesystem from '../common/filesystem'
import { sessionAttachmentContext } from '../session/session-attachment-context'
import { materializeAttachmentRequest } from '../providers/attachment-input'
import {
  createTestDatabase,
  type TestDatabase,
} from '../persistence/test-database'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import {
  messageFixtures,
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { ProjectArtifactService } from '../project-artifacts/service'
import {
  writeSessionArtifactText,
  type SessionTempPaths,
} from '../session-temp/service'
import { AttachmentService } from './service'

let db: TestDatabase
let artifacts: ProjectArtifactService
let attachments: AttachmentService
let paths: SessionTempPaths
let workspace: string
let base: string
let attachment: Attachment
const sessionRecord = sessionFixture({ lastSeq: 0 })
const projectId = sessionRecord.projectId

beforeEach(async () => {
  db = await createTestDatabase()
  workspace = path.join(db.directory, 'workspace')
  await mkdir(workspace)
  workspace = await realpath(workspace)
  base = path.join(db.directory, 'runtime')
  await db.database.withTransaction((tx) => {
    new ProjectRepository().insert(tx, projectFixture({ path: workspace }))
    new SessionRepository().insert(tx, sessionRecord)
  })
  artifacts = new ProjectArtifactService({
    database: db.database,
    profileDirectory: db.directory,
    rootDirectory: base,
  })
  await artifacts.initialize()
  paths = await artifacts.ensureSession(sessionRecord.id)
  attachments = new AttachmentService({
    database: db.database,
    profileDirectory: db.directory,
  })
  await attachments.initialize()
  const source = path.join(db.directory, 'notes.txt')
  await writeFile(source, 'original attachment')
  attachment = await attachments.importLocalFile(
    { projectId, draftKey: 'draft' },
    source,
  )
  await unlink(source)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await attachments?.dispose()
  await artifacts?.dispose()
  await db?.dispose()
})

async function removeManaged(target: string): Promise<void> {
  const relative = path.relative(db.directory, path.resolve(target))
  expect(relative).not.toBe('')
  expect(relative.startsWith('..')).toBe(false)
  expect(path.isAbsolute(relative)).toBe(false)
  await rm(target, { recursive: true, force: true })
}

function context() {
  const record = messageFixtures(sessionRecord.id).find(
    (message) => message.kind === 'user_input',
  )!
  const session = {
    sessionTemp: paths,
    history: [
      {
        ...record,
        parts: [attachmentPart(attachment)],
      },
    ],
  }
  const run = {
    runId: 'run:recovery' as RunId,
    controller: new AbortController(),
  }
  return sessionAttachmentContext(attachments, session, run)
}

describe('runtime directory recovery', () => {
  it.each(['base', 'project', 'tmp', 'scratch', 'workspace'] as const)(
    'recreates a removed %s entry at the registered paths under concurrent hydration',
    async (entry) => {
      const target = {
        base,
        project: path.dirname(paths.root),
        tmp: paths.root,
        scratch: paths.scratch,
        workspace: paths.workspaceAlias!,
      }[entry]
      if (entry === 'workspace') await unlink(target)
      else await removeManaged(target)
      const restored = await Promise.all(
        Array.from({ length: 8 }, () =>
          artifacts.ensureSession(sessionRecord.id),
        ),
      )
      for (const result of restored) {
        expect(result.root).toBe(paths.root)
        expect(await realpath(result.workspaceAlias!)).toBe(workspace)
        expect(await realpath(result.scratch)).toBe(
          path.join(result.canonicalRoot!, 'scratch'),
        )
      }
      expect(
        (await attachments.preflight(projectId, [attachment.id]))[0],
      ).toEqual(attachment)
    },
  )

  it('allows new captures through an existing session view after its root is cleaned', async () => {
    const old = await writeSessionArtifactText(
      paths,
      ['web-search', 'old.json'],
      'old output',
    )
    await removeManaged(base)
    const fresh = await writeSessionArtifactText(
      paths,
      ['web-search', 'new.json'],
      'new output',
    )
    expect(await readFile(fresh, 'utf8')).toBe('new output')
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores a removed working copy without overwriting surviving edits', async () => {
    const resolver = context()
    const first = await resolver.resolveFile!(attachment, resolver.signal)
    await writeFile(first, 'edited by a tool')
    expect(await resolver.resolveFile!(attachment, resolver.signal)).toBe(first)
    expect(await readFile(first, 'utf8')).toBe('edited by a tool')
    await unlink(first)
    expect(await resolver.resolveFile!(attachment, resolver.signal)).toBe(first)
    expect(await readFile(first, 'utf8')).toBe('original attachment')
  })

  it.each(['scratch', 'base'] as const)(
    'prepares a provider request after %s is cleaned mid-run',
    async (entry) => {
      const resolver = context()
      const file = await resolver.resolveFile!(attachment, resolver.signal)
      await removeManaged(entry === 'base' ? base : paths.scratch)
      const placeholder = 'zch-file:' + attachment.id
      const request = await materializeAttachmentRequest(
        {
          request: { text: placeholder },
          attachmentBindings: [
            { attachment, path: ['text'], placeholder, encoding: 'file-path' },
          ],
        },
        resolver,
      )
      expect(request.text).toContain(JSON.stringify(file))
      expect(await readFile(file, 'utf8')).toBe('original attachment')
    },
  )

  it('shares concurrent materialization without exposing unfinished or conflicting copies', async () => {
    const resolver = context()
    const copies = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolver.resolveFile!(attachment, resolver.signal),
      ),
    )
    expect(new Set(copies).size).toBe(1)
    expect(await readFile(copies[0], 'utf8')).toBe('original attachment')
  })

  it('does not reuse a partial working copy after a failed restoration write', async () => {
    const resolver = context()
    const copy = await resolver.resolveFile!(attachment, resolver.signal)
    await unlink(copy)
    const open = filesystem.openFileHandle
    const mocked = vi
      .spyOn(filesystem, 'openFileHandle')
      .mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (String(args[0]).endsWith('.copy.tmp')) {
          const write = handle.writeFile.bind(handle)
          vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
            await write('partial')
            throw new Error('Restoration write failed')
          })
        }
        return handle
      })
    await expect(
      resolver.resolveFile!(attachment, resolver.signal),
    ).rejects.toThrow('Restoration write failed')
    await expect(readFile(copy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(path.dirname(copy))).toEqual([])
    mocked.mockRestore()
    await resolver.resolveFile!(attachment, resolver.signal)
    expect(await readFile(copy, 'utf8')).toBe('original attachment')
  })

  it.each(['base', 'project', 'scratch', 'attachment-directory'] as const)(
    'rejects a replaced %s junction before restoring files',
    async (entry) => {
      const resolver = context()
      const copy = await resolver.resolveFile!(attachment, resolver.signal)
      const outside = path.join(db.directory, 'outside')
      await mkdir(outside)
      const sentinel = path.join(outside, attachment.name)
      await writeFile(sentinel, 'untouched')
      const target = {
        base,
        project: path.dirname(paths.root),
        scratch: paths.scratch,
        'attachment-directory': path.dirname(copy),
      }[entry]
      await removeManaged(target)
      await symlink(
        outside,
        target,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      try {
        await expect(
          resolver.resolveFile!(attachment, resolver.signal),
        ).rejects.toThrow()
        expect(await readFile(sentinel, 'utf8')).toBe('untouched')
      } finally {
        await unlink(target)
      }
    },
  )

  it('does not adopt a nonempty project directory whose owner marker disappeared', async () => {
    await unlink(path.join(path.dirname(paths.root), '.project-owner.json'))
    await expect(artifacts.ensureSession(sessionRecord.id)).rejects.toThrow()
    expect(await realpath(paths.workspaceAlias!)).toBe(workspace)
  })

  it('does not restore a project with a mismatched owner marker', async () => {
    await writeFile(
      path.join(path.dirname(paths.root), '.project-owner.json'),
      JSON.stringify({ projectId: 'another-project', rootId: 1 }),
    )
    await expect(artifacts.ensureSession(sessionRecord.id)).rejects.toThrow(
      'ownership mismatch',
    )
  })
})
