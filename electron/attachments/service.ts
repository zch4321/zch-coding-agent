import { createHash, randomBytes, type Hash } from 'node:crypto'
import path from 'node:path'
import {
  ATTACHMENT_LIMITS,
  assertAttachmentLimits,
  type Attachment,
  type ImageAttachment,
} from '../../shared/attachments'
import type { ProjectId, RunId } from '../../shared/ids'
import { DomainError } from '../common/domain-error'
import {
  canonicalPath,
  fileStatus,
  linkStatus,
  makeDirectory,
  openFileHandle,
  readDirectory,
  writeFileContents,
  renamePath,
  type FileHandle,
} from '../common/filesystem'
import type { DatabaseService } from '../persistence/database-service'
import { AttachmentRepository } from '../persistence/attachment-repository'
import { processAttachmentImage } from './image-processing'
import {
  attachmentProjectDirectory,
  checkedAttachmentPath,
  ensureAttachmentDirectory,
  removeAttachmentDirectory,
} from './paths'

export interface AttachmentImportInput {
  projectId: ProjectId
  draftKey: string
  name: string
  mimeType: string
  byteSize: number
}
interface Transfer {
  input: AttachmentImportInput
  directory: string
  file: FileHandle
  hash: Hash
  received: number
  cancelled: boolean
  tail: Promise<unknown>
  lastActivity: number
  finishing: boolean
}
const ORPHAN_GRACE_MS = 24 * 60 * 60_000

/** Owns immutable local inputs, bounded imports, image variants and reference-aware collection. */
export class AttachmentService {
  readonly #database: DatabaseService
  readonly #repository = new AttachmentRepository()
  readonly #transfers = new Map<string, Transfer>()
  readonly #now: () => number
  readonly #diagnostic: (message: string, error?: unknown) => void
  #root: string
  #closed = false
  #timer?: ReturnType<typeof setInterval>
  #collecting?: Promise<void>
  #beginTail: Promise<unknown> = Promise.resolve()

  constructor(options: {
    database: DatabaseService
    profileDirectory: string
    now?: () => number
    onDiagnostic?: (message: string, error?: unknown) => void
  }) {
    this.#database = options.database
    this.#root = path.resolve(options.profileDirectory, 'attachments')
    this.#now = options.now ?? Date.now
    this.#diagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /** Prepares profile-owned storage and removes interrupted transfers after exclusive profile ownership. */
  async initialize(): Promise<void> {
    await makeDirectory(this.#root, { recursive: true, mode: 0o700 })
    if ((await linkStatus(this.#root)).isSymbolicLink())
      throw new Error('Attachment storage must not be a symlink')
    this.#root = await canonicalPath(this.#root)
    await removeAttachmentDirectory(
      this.#root,
      path.join(this.#root, '_imports'),
    )
    await ensureAttachmentDirectory(
      this.#root,
      path.join(this.#root, '_imports'),
    )
    this.#timer = setInterval(() => {
      void this.collect().catch((error) =>
        this.#diagnostic('Attachment cleanup failed', error),
      )
    }, 60_000)
    this.#timer.unref()
  }

  /** Reserves an import for its original frontend draft; no arbitrary renderer path is accepted. */
  begin(input: AttachmentImportInput): Promise<string> {
    const result = this.#beginTail.then(() => this.#begin(input))
    this.#beginTail = result.catch(() => undefined)
    return result
  }

  async #begin(input: AttachmentImportInput): Promise<string> {
    if (this.#closed)
      throw new DomainError('CANCELLED', 'Attachment service is closed')
    if (
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 0 ||
      input.byteSize > ATTACHMENT_LIMITS.fileBytes ||
      this.#transfers.size >= ATTACHMENT_LIMITS.count
    ) {
      throw new DomainError(
        'PAYLOAD_TOO_LARGE',
        'Attachment import exceeds the size or concurrency limit',
      )
    }
    if (
      !this.#database.read((reader) =>
        reader
          .prepare('SELECT id FROM projects WHERE id = ?')
          .get(input.projectId),
      )
    )
      throw new DomainError('NOT_FOUND', 'Attachment project no longer exists')
    const pending = [...this.#transfers.values()].filter(
      (transfer) =>
        transfer.input.projectId === input.projectId &&
        transfer.input.draftKey === input.draftKey,
    )
    if (
      pending.reduce(
        (sum, transfer) => sum + transfer.input.byteSize,
        input.byteSize,
      ) > ATTACHMENT_LIMITS.messageBytes
    )
      throw new DomainError(
        'PAYLOAD_TOO_LARGE',
        'Attachment batch exceeds the size limit',
      )
    const id = randomBytes(16).toString('hex')
    const directory = path.join(this.#root, '_imports', id)
    await ensureAttachmentDirectory(this.#root, directory)
    const file = await openFileHandle(
      path.join(directory, 'original'),
      'wx',
      0o600,
    )
    this.#transfers.set(id, {
      input: { ...input, name: safeName(input.name) },
      directory,
      file,
      received: 0,
      hash: createHash('sha256'),
      cancelled: false,
      tail: Promise.resolve(),
      lastActivity: this.#now(),
      finishing: false,
    })
    return id
  }

  /** Writes one strictly ordered, bounded Base64 transport chunk without retaining it in state. */
  append(id: string, offset: number, data: string): Promise<void> {
    const transfer = this.#requireTransfer(id)
    return this.#enqueue(transfer, async () => {
      if (transfer.cancelled)
        throw new DomainError('CANCELLED', 'Attachment import was cancelled')
      if (
        offset !== transfer.received ||
        data.length > Math.ceil(ATTACHMENT_LIMITS.chunkBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
          data,
        )
      )
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Invalid attachment chunk or offset',
        )
      const bytes = Buffer.from(data, 'base64')
      if (
        !bytes.length ||
        bytes.byteLength > ATTACHMENT_LIMITS.chunkBytes ||
        offset + bytes.byteLength > transfer.input.byteSize
      )
        throw new DomainError(
          'PAYLOAD_TOO_LARGE',
          'Attachment chunk exceeds the declared size',
        )
      let written = 0
      while (written < bytes.length) {
        const result = await transfer.file.write(
          bytes,
          written,
          bytes.length - written,
          offset + written,
        )
        if (!result.bytesWritten)
          throw new Error('Attachment write made no progress')
        written += result.bytesWritten
      }
      transfer.hash.update(bytes)
      transfer.received += bytes.byteLength
      transfer.lastActivity = this.#now()
    })
  }

  /** Seals and validates a snapshot, then commits metadata and its draft protection atomically. */
  finish(id: string): Promise<Attachment> {
    const transfer = this.#requireTransfer(id)
    transfer.finishing = true
    return this.#enqueue(transfer, async () => {
      let installed: string | undefined
      try {
        if (transfer.cancelled)
          throw new DomainError('CANCELLED', 'Attachment import was cancelled')
        if (transfer.received !== transfer.input.byteSize)
          throw new DomainError(
            'PRECONDITION_FAILED',
            'Attachment import is incomplete',
          )
        await transfer.file.sync()
        await transfer.file.close()
        const source = path.join(transfer.directory, 'original')
        const header = await readHeader(source)
        const image = isImageHeader(header)
        if (image && transfer.received > ATTACHMENT_LIMITS.imageBytes)
          throw new DomainError(
            'PAYLOAD_TOO_LARGE',
            'Image exceeds the 20 MiB import limit',
          )
        if (
          !image &&
          /^(image\/(png|jpeg|webp))$/u.test(transfer.input.mimeType)
        )
          throw new DomainError('PRECONDITION_FAILED', 'Image file is invalid')
        const common = {
          id,
          projectId: transfer.input.projectId,
          name: transfer.input.name,
          byteSize: transfer.received,
          sha256: transfer.hash.digest('hex'),
        }
        const attachment: Attachment = image
          ? {
              ...common,
              kind: 'image',
              ...(await processAttachmentImage(source, transfer.directory)),
            }
          : {
              ...common,
              kind: 'file',
              mimeType: safeMime(transfer.input.mimeType),
            }
        if (transfer.cancelled || this.#closed)
          throw new DomainError('CANCELLED', 'Attachment import was cancelled')
        const projectDirectory = attachmentProjectDirectory(
          this.#root,
          attachment.projectId,
        )
        await ensureAttachmentDirectory(this.#root, projectDirectory)
        installed = path.join(projectDirectory, id)
        await renamePath(transfer.directory, installed)
        await this.#database.withTransaction((transaction) => {
          if (transfer.cancelled || this.#closed)
            throw new DomainError(
              'CANCELLED',
              'Attachment import was cancelled',
            )
          this.#repository.insert(
            transaction,
            attachment,
            transfer.input.draftKey,
            this.#now(),
          )
        })
        return attachment
      } catch (error) {
        await transfer.file.close().catch(() => undefined)
        await removeAttachmentDirectory(
          this.#root,
          installed ?? transfer.directory,
        )
        throw error
      } finally {
        this.#transfers.delete(id)
      }
    })
  }

  /** Cancels an import and waits for any in-flight write/decoder before deleting staging files. */
  async cancel(id: string): Promise<void> {
    const transfer = this.#transfers.get(id)
    if (!transfer) return
    transfer.cancelled = true
    await transfer.tail.catch(() => undefined)
    await transfer.file.close().catch(() => undefined)
    await removeAttachmentDirectory(this.#root, transfer.directory)
    this.#transfers.delete(id)
  }

  /** Imports a host-selected file through the same bounded transfer pipeline as browser Blobs. */
  async importLocalFile(
    input: Omit<AttachmentImportInput, 'byteSize' | 'name' | 'mimeType'>,
    nativePath: string,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    signal?.throwIfAborted()
    const file = await openFileHandle(nativePath, 'r')
    let id: string | undefined
    const cancelImport = () => {
      if (id)
        void this.cancel(id).catch((error) =>
          this.#diagnostic('Attachment cancellation failed', error),
        )
    }
    try {
      const info = await file.stat()
      if (!info.isFile())
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Only regular files can be attached',
        )
      id = await this.begin({
        ...input,
        name: path.basename(nativePath),
        mimeType: 'application/octet-stream',
        byteSize: info.size,
      })
      signal?.addEventListener('abort', cancelImport, { once: true })
      if (signal?.aborted) cancelImport()
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(ATTACHMENT_LIMITS.chunkBytes)
      let offset = 0
      while (offset < info.size) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, info.size - offset),
          offset,
        )
        if (!bytesRead)
          throw new DomainError(
            'RESOURCE_CHANGED',
            'Source file changed during import',
          )
        await this.append(
          id,
          offset,
          buffer.subarray(0, bytesRead).toString('base64'),
        )
        offset += bytesRead
      }
      const current = await file.stat()
      signal?.throwIfAborted()
      if (current.size !== info.size || current.mtimeMs !== info.mtimeMs)
        throw new DomainError(
          'RESOURCE_CHANGED',
          'Source file changed during import',
        )
      return await this.finish(id)
    } catch (error) {
      if (id) await this.cancel(id)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancelImport)
      await file.close()
    }
  }

  /** Loads descriptors for a validated project and verifies per-message limits. */
  getMany(projectId: ProjectId, ids: readonly string[]): Attachment[] {
    const attachments = this.#database.read((reader) =>
      this.#repository.require(reader, projectId, ids),
    )
    assertAttachmentLimits(attachments)
    return attachments
  }

  /** Verifies snapshot integrity before a user turn is durably accepted. */
  async preflight(
    projectId: ProjectId,
    ids: readonly string[],
  ): Promise<Attachment[]> {
    const attachments = this.getMany(projectId, ids)
    for (const attachment of attachments)
      await this.#readVerified(
        attachment,
        attachment.kind === 'image' ? 'request.jpg' : 'original',
      )
    return attachments
  }

  /** Replaces one draft's references while preserving unfinished imports owned by it. */
  async syncDraft(
    projectId: ProjectId,
    draftKey: string,
    ids: string[],
  ): Promise<void> {
    this.getMany(projectId, ids)
    await this.#database.withTransaction((transaction) =>
      this.#repository.setDraft(transaction, projectId, draftKey, ids),
    )
  }

  /** Reconciles restored localStorage drafts without making main the owner of draft text. */
  async reconcileDrafts(
    projectId: ProjectId,
    drafts: { key: string; ids: string[] }[],
  ): Promise<void> {
    await this.#database.withTransaction((transaction) =>
      this.#repository.reconcileDrafts(transaction, projectId, drafts),
    )
    await this.collect()
  }

  /** Reads a small validated image request variant within the current project's boundary. */
  async resolveImage(
    projectId: ProjectId,
    attachment: ImageAttachment,
    signal: AbortSignal,
  ): Promise<Buffer> {
    signal.throwIfAborted()
    const stored = this.getMany(projectId, [attachment.id])[0]
    if (
      stored.kind !== 'image' ||
      stored.requestSha256 !== attachment.requestSha256
    )
      throw new DomainError(
        'RESOURCE_CHANGED',
        'Attachment image metadata changed',
      )
    const bytes = await this.#readVerified(stored, 'request.jpg')
    signal.throwIfAborted()
    return bytes
  }

  /** Exposes only generated JPEG previews; originals and arbitrary profile files are never served. */
  async preview(id: string, variant: 'thumbnail' | 'preview'): Promise<Buffer> {
    const attachment = this.#database.read((reader) =>
      this.#repository.get(reader, id),
    )
    if (!attachment || attachment.kind !== 'image')
      throw new DomainError('NOT_FOUND', 'Attachment image is unavailable')
    return this.#readVerified(
      attachment,
      variant === 'thumbnail' ? 'thumbnail.jpg' : 'request.jpg',
    )
  }

  /** Copies an immutable ordinary file into the existing tool-accessible scratch directory. */
  async materializeFile(
    projectId: ProjectId,
    id: string,
    scratch: string,
    signal: AbortSignal,
    runId: RunId,
  ): Promise<string> {
    signal.throwIfAborted()
    const attachment = this.getMany(projectId, [id])[0]
    const bytes = await this.#readVerified(attachment, 'original')
    const root = await canonicalPath(scratch)
    const runDirectory = createHash('sha256')
      .update(runId)
      .digest('hex')
      .slice(0, 32)
    const directory = path.join(root, 'attachments', runDirectory, id)
    await ensureAttachmentDirectory(root, directory)
    const destination = path.join(directory, attachment.name)
    const existing = await linkStatus(destination).catch(() => undefined)
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw new Error('Invalid attachment working copy')
    // Exclusive creation never overwrites another Run's copy or follows an existing hard link.
    await writeFileContents(destination, bytes, { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    return destination
  }

  /** Removes unreferenced snapshots after the crash-recovery grace period. */
  collect(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#collecting ??= this.#collect().finally(() => {
      this.#collecting = undefined
    })
    return this.#collecting
  }

  /** Clears a removed project's private storage only after its references have been deleted. */
  async removeProject(projectId: ProjectId): Promise<void> {
    for (const [id, transfer] of this.#transfers)
      if (transfer.input.projectId === projectId) await this.cancel(id)
    await removeAttachmentDirectory(
      this.#root,
      attachmentProjectDirectory(this.#root, projectId),
    )
  }

  /** Stops collection and drains all import writes before the database closes. */
  async dispose(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    await this.#beginTail
    await this.#collecting
    await Promise.all([...this.#transfers.keys()].map((id) => this.cancel(id)))
  }

  #requireTransfer(id: string): Transfer {
    const transfer = this.#transfers.get(id)
    if (!transfer)
      throw new DomainError('NOT_FOUND', 'Attachment import is unavailable')
    return transfer
  }

  #enqueue<T>(transfer: Transfer, work: () => Promise<T>): Promise<T> {
    const result = transfer.tail.then(work)
    transfer.tail = result.catch(() => undefined)
    return result
  }

  async #filePath(attachment: Attachment, variant: string): Promise<string> {
    return checkedAttachmentPath(
      this.#root,
      path.join(
        attachmentProjectDirectory(this.#root, attachment.projectId),
        attachment.id,
        variant,
      ),
    )
  }

  async #readVerified(
    attachment: Attachment,
    variant: string,
  ): Promise<Buffer> {
    const filePath = await this.#filePath(attachment, variant)
    const maximum =
      variant === 'original'
        ? ATTACHMENT_LIMITS.fileBytes
        : ATTACHMENT_LIMITS.imageRequestBytes
    const info = await fileStatus(filePath)
    if (!info.isFile() || info.size > maximum)
      throw new DomainError(
        'RESOURCE_CHANGED',
        'Attachment file has an invalid size',
      )
    const file = await openFileHandle(filePath, 'r')
    let bytes: Buffer
    try {
      const opened = await file.stat()
      if (
        opened.ino !== info.ino ||
        opened.dev !== info.dev ||
        !opened.isFile() ||
        opened.size !== info.size
      )
        throw new DomainError(
          'RESOURCE_CHANGED',
          'Attachment file changed while opening',
        )
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          Math.min(ATTACHMENT_LIMITS.chunkBytes, buffer.length - length),
          length,
        )
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== info.size)
        throw new DomainError(
          'RESOURCE_CHANGED',
          'Attachment file changed while reading',
        )
      bytes = buffer.subarray(0, length)
    } finally {
      await file.close()
    }
    const expected =
      variant === 'original'
        ? attachment.sha256
        : attachment.kind === 'image' && variant === 'request.jpg'
          ? attachment.requestSha256
          : undefined
    if (
      expected &&
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      throw new DomainError('RESOURCE_CHANGED', 'Attachment file is damaged')
    return bytes
  }

  async #collect(): Promise<void> {
    for (const [id, transfer] of this.#transfers) {
      if (
        !transfer.finishing &&
        this.#now() - transfer.lastActivity > 5 * 60_000
      )
        await this.cancel(id)
    }
    const expired = await this.#database.withTransaction((transaction) =>
      this.#repository.markUnused(transaction, this.#now() - ORPHAN_GRACE_MS),
    )
    for (const attachment of expired) {
      await removeAttachmentDirectory(
        this.#root,
        path.join(
          attachmentProjectDirectory(this.#root, attachment.projectId),
          attachment.id,
        ),
      )
      await this.#database.withTransaction((transaction) =>
        this.#repository.deleteCollected(transaction, attachment.id),
      )
    }
    // Recover snapshots installed just before a crash or whose project was deleted before host cleanup.
    for (const project of await readDirectory(this.#root, {
      withFileTypes: true,
    })) {
      if (
        !/^[a-f0-9]{32}$/u.test(project.name) ||
        !project.isDirectory() ||
        project.isSymbolicLink()
      )
        continue
      const directory = await checkedAttachmentPath(
        this.#root,
        path.join(this.#root, project.name),
      )
      for (const asset of await readDirectory(directory, {
        withFileTypes: true,
      })) {
        if (
          !/^[a-f0-9]{32}$/u.test(asset.name) ||
          !asset.isDirectory() ||
          asset.isSymbolicLink() ||
          this.#transfers.has(asset.name)
        )
          continue
        if (
          this.#database.read((reader) =>
            this.#repository.get(reader, asset.name, true),
          )
        )
          continue
        const target = path.join(directory, asset.name)
        if ((await fileStatus(target)).mtimeMs < this.#now() - ORPHAN_GRACE_MS)
          await removeAttachmentDirectory(this.#root, target)
      }
    }
  }
}

function safeName(name: string): string {
  const sanitized = name
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
    .slice(0, 180)
  return !sanitized ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(sanitized)
    ? `attachment-${sanitized || 'file'}`
    : sanitized
}

function safeMime(mime: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(mime) && mime.length <= 128
    ? mime
    : 'application/octet-stream'
}

async function readHeader(filePath: string): Promise<Buffer> {
  const file = await openFileHandle(filePath, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await file.read(buffer, 0, 16, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

function isImageHeader(header: Buffer): boolean {
  return (
    header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (header[0] === 255 && header[1] === 216 && header[2] === 255) ||
    (header.subarray(0, 4).toString() === 'RIFF' &&
      header.subarray(8, 12).toString() === 'WEBP')
  )
}
