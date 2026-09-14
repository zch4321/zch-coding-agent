import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import sharp from 'sharp'
import { randomBytes } from 'node:crypto'
import {
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
  readdir,
} from 'node:fs/promises'
import { AttachmentService } from './service'
import {
  createTestDatabase,
  type TestDatabase,
} from '../persistence/test-database'
import {
  projectFixture,
  sessionFixture,
  messageFixtures,
} from '../persistence/repository-fixtures'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import { MessageRepository } from '../persistence/message-repository'
import { AttachmentRepository } from '../persistence/attachment-repository'
import {
  ATTACHMENT_LIMITS,
  attachmentPart,
  type Attachment,
} from '../../shared/attachments'
import type { MessageId, SessionId, ProjectId, RunId } from '../../shared/ids'
import { attachmentPreviewResponse } from './preview-protocol'

let db: TestDatabase
let service: AttachmentService
let now = Date.now()
const project = projectFixture()

beforeEach(async () => {
  db = await createTestDatabase()
  await db.database.withTransaction((transaction) =>
    new ProjectRepository().insert(transaction, project),
  )
  service = new AttachmentService({
    database: db.database,
    profileDirectory: db.directory,
    now: () => now,
  })
  await service.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await service.dispose()
  await db.dispose()
})

async function importBytes(
  bytes: Buffer,
  name = 'file.txt',
  mimeType = 'text/plain',
): Promise<Attachment> {
  const id = await service.begin({
    projectId: project.id,
    draftKey: 'draft',
    name,
    mimeType,
    byteSize: bytes.length,
  })
  for (
    let offset = 0;
    offset < bytes.length;
    offset += ATTACHMENT_LIMITS.chunkBytes
  )
    await service.append(
      id,
      offset,
      bytes
        .subarray(offset, offset + ATTACHMENT_LIMITS.chunkBytes)
        .toString('base64'),
    )
  return service.finish(id)
}

describe('immutable attachment storage', () => {
  it('cancels a native file import between chunks and removes its staging directory', async () => {
    const file = path.join(db.directory, 'large-file.txt')
    await writeFile(file, Buffer.alloc(ATTACHMENT_LIMITS.chunkBytes * 3, 120))
    const controller = new AbortController()
    const append = service.append.bind(service)
    const writes = vi
      .spyOn(service, 'append')
      .mockImplementation(async (...args) => {
        await append(...args)
        controller.abort()
      })
    await expect(
      service.importLocalFile(
        { projectId: project.id, draftKey: 'draft' },
        file,
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(
      await readdir(path.join(db.directory, 'attachments', '_imports')),
    ).toEqual([])
    expect(
      db.database.read((reader) =>
        reader.prepare('SELECT id FROM attachments').all(),
      ),
    ).toEqual([])
  })

  it('accepts ordered chunks and rejects oversized, invalid and incomplete uploads', async () => {
    const id = await service.begin({
      projectId: project.id,
      draftKey: 'draft',
      name: 'x',
      mimeType: '',
      byteSize: 4,
    })
    await expect(service.append(id, 1, 'eA==')).rejects.toThrow('offset')
    await expect(service.append(id, 0, '!')).rejects.toThrow('chunk')
    await service.append(id, 0, 'eA==')
    await expect(service.finish(id)).rejects.toThrow('incomplete')
    expect(() => service.finish(id)).toThrow('unavailable')
    const file = await importBytes(randomBytes(300_000))
    expect(file.byteSize).toBe(300_000)
    expect(service.getMany(project.id, [file.id])).toEqual([file])
    expect(() => service.getMany('other' as ProjectId, [file.id])).toThrow(
      'project',
    )
  })

  it('creates oriented bounded JPEG variants and rejects damaged or animated supported images', async () => {
    const bytes = await sharp({
      create: { width: 2800, height: 1800, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer()
    const image = await importBytes(bytes, 'image.png', 'image/png')
    expect(image.kind).toBe('image')
    if (image.kind !== 'image') throw new Error('Expected image')
    const resolved = await service.resolveImage(
      project.id,
      image,
      new AbortController().signal,
    )
    expect((await sharp(resolved).metadata()).width).toBe(2048)
    expect(resolved.length).toBeLessThanOrEqual(
      ATTACHMENT_LIMITS.imageRequestBytes,
    )
    const preview = await attachmentPreviewResponse(
      service,
      new Request(`zch-attachment://asset/${image.id}/thumbnail`),
    )
    expect(preview.status).toBe(200)
    expect(
      (await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width,
    ).toBeLessThanOrEqual(192)
    expect(
      (
        await attachmentPreviewResponse(
          service,
          new Request(`zch-attachment://asset/${image.id}/original`),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await attachmentPreviewResponse(
          service,
          new Request(
            `zch-attachment://asset/${image.id}/preview?path=C:/secret`,
          ),
        )
      ).status,
    ).toBe(404)
    await expect(
      importBytes(Buffer.from('invalid'), 'image.png', 'image/png'),
    ).rejects.toThrow('invalid')
  })

  it('keeps snapshots after source deletion, restores working copies and cancels imports', async () => {
    const source = path.join(db.directory, 'source.txt')
    await writeFile(source, 'original')
    const file = await service.importLocalFile(
      { projectId: project.id, draftKey: 'draft' },
      source,
    )
    await rm(source)
    const destination = await service.materializeFile(
      project.id,
      file.id,
      db.directory,
      new AbortController().signal,
      'run:first' as RunId,
    )
    expect(await readFile(destination, 'utf8')).toBe('original')
    await writeFile(destination, 'edited')
    const secondDestination = await service.materializeFile(
      project.id,
      file.id,
      db.directory,
      new AbortController().signal,
      'run:second' as RunId,
    )
    expect(secondDestination).not.toBe(destination)
    expect(await readFile(secondDestination, 'utf8')).toBe('original')
    expect(await readFile(destination, 'utf8')).toBe('edited')
    await service.dispose()
    service = new AttachmentService({
      database: db.database,
      profileDirectory: db.directory,
      now: () => now,
    })
    await service.initialize()
    expect(service.getMany(project.id, [file.id])).toEqual([file])
    const id = await service.begin({
      projectId: project.id,
      draftKey: 'draft',
      name: 'cancel',
      mimeType: '',
      byteSize: 1,
    })
    await service.cancel(id)
    expect(() => service.append(id, 0, 'eA==')).toThrow('unavailable')
  })

  it('commits message references atomically and preserves a fork after its source is deleted', async () => {
    const file = await importBytes(Buffer.from('snapshot'))
    const session = sessionFixture()
    const fork = sessionFixture({ id: 'session:fork' as SessionId })
    const original = messageFixtures()[0]
    if (original.kind !== 'user_input') throw new Error('Expected user fixture')
    const message = { ...original, parts: [attachmentPart(file)] }
    await db.database.withTransaction((transaction) => {
      const sessions = new SessionRepository()
      sessions.insert(transaction, session)
      sessions.insert(transaction, fork)
      new MessageRepository().insert(transaction, message)
      new MessageRepository().insert(transaction, {
        ...message,
        id: 'message:fork' as MessageId,
        sessionId: fork.id,
      })
    })
    await service.syncDraft(project.id, 'draft', [])
    now += 25 * 60 * 60_000
    await db.database.withTransaction((transaction) => {
      transaction.prepare('DELETE FROM sessions WHERE id = ?').run(session.id)
    })
    await service.collect()
    expect(service.getMany(project.id, [file.id])).toEqual([file])
    await db.database.withTransaction((transaction) => {
      transaction.prepare('DELETE FROM sessions WHERE id = ?').run(fork.id)
    })
    await service.collect()
    expect(() => service.getMany(project.id, [file.id])).toThrow('unavailable')
  })

  it('protects unsent assets until localStorage draft reconciliation releases them', async () => {
    const file = await importBytes(Buffer.from('draft'))
    now += 25 * 60 * 60_000
    await service.collect()
    expect(service.getMany(project.id, [file.id])).toEqual([file])
    await service.reconcileDrafts(project.id, [])
    expect(
      db.database.read((reader) =>
        new AttachmentRepository().get(reader, file.id),
      ),
    ).toBeUndefined()
  })

  it('cascades project removal even when messages reference attachment snapshots', async () => {
    const file = await importBytes(Buffer.from('project attachment'))
    const user = messageFixtures()[0]
    if (user.kind !== 'user_input') throw new Error('Expected user')
    await db.database.withTransaction((transaction) => {
      new SessionRepository().insert(transaction, sessionFixture())
      new MessageRepository().insert(transaction, {
        ...user,
        parts: [attachmentPart(file)],
      })
    })
    await db.database.withTransaction((transaction) =>
      new ProjectRepository().delete(transaction, project.id),
    )
    await service.removeProject(project.id)
    expect(
      db.database.read((reader) =>
        new AttachmentRepository().get(reader, file.id),
      ),
    ).toBeUndefined()
  })

  it('does not overwrite symlink working copies', async () => {
    const file = await importBytes(Buffer.from('safe'))
    const signal = new AbortController().signal
    const destination = await service.materializeFile(
      project.id,
      file.id,
      db.directory,
      signal,
      'run:link' as RunId,
    )
    await rm(path.dirname(destination), { recursive: true })
    const outsideDirectory = path.join(db.directory, 'outside')
    await mkdir(outsideDirectory)
    const outside = path.join(outsideDirectory, file.name)
    await writeFile(outside, 'keep')
    await symlink(outsideDirectory, path.dirname(destination), 'junction')
    await expect(
      service.materializeFile(
        project.id,
        file.id,
        db.directory,
        signal,
        'run:link' as RunId,
      ),
    ).rejects.toThrow('directory')
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })
})
