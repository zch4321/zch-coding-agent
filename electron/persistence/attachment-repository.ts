import { Value } from '@sinclair/typebox/value'
import { AttachmentSchema, type Attachment } from '../../shared/attachments'
import type { ProjectId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import { DomainError } from '../common/domain-error'

const UNUSED = `NOT EXISTS (SELECT 1 FROM message_attachments m WHERE m.attachment_id = attachments.id)
  AND NOT EXISTS (SELECT 1 FROM attachment_drafts d WHERE d.attachment_id = attachments.id)`

/** Persists immutable attachment metadata and tracks message/draft references transactionally. */
export class AttachmentRepository {
  /** Loads validated metadata, optionally including tombstones pending filesystem cleanup. */
  get(
    reader: PersistenceReader,
    id: string,
    includeDeleting = false,
  ): Attachment | undefined {
    const row = reader
      .prepare(
        `SELECT descriptor_json FROM attachments WHERE id = ? ${includeDeleting ? '' : "AND status = 'ready'"}`,
      )
      .get(id)
    if (!row) return undefined
    const value: unknown = JSON.parse(String(row.descriptor_json))
    if (!Value.Check(AttachmentSchema, value))
      throw new Error('Invalid stored attachment metadata')
    return value
  }

  /** Registers one ready snapshot and protects it with its originating draft. */
  insert(
    transaction: PersistenceTransaction,
    attachment: Attachment,
    draftKey: string,
    now: number,
  ): void {
    transaction
      .prepare(
        "INSERT INTO attachments(id, project_id, descriptor_json, status, created_at) VALUES(?,?,?,'ready',?)",
      )
      .run(attachment.id, attachment.projectId, JSON.stringify(attachment), now)
    this.retainDraft(transaction, attachment.projectId, draftKey, [
      attachment.id,
    ])
  }

  /** Rejects missing assets and references crossing a project's ownership boundary. */
  require(
    reader: PersistenceReader,
    projectId: ProjectId,
    ids: readonly string[],
  ): Attachment[] {
    return ids.map((id) => {
      const attachment = this.get(reader, id)
      if (!attachment || attachment.projectId !== projectId) {
        throw new DomainError(
          'NOT_FOUND',
          'Attachment is unavailable in this project',
        )
      }
      return attachment
    })
  }

  /** Associates canonical parts with the message in the same transaction as its insert. */
  linkMessage(
    transaction: PersistenceTransaction,
    record: MessageRecord,
  ): void {
    const parts = record.parts.filter(
      (part) => part.type === 'image' || part.type === 'file',
    )
    if (!parts.length) return
    const session = transaction
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(record.sessionId)
    const attachments = this.require(
      transaction,
      String(session?.project_id) as ProjectId,
      parts.map((part) => part.attachment.id),
    )
    for (const [position, attachment] of attachments.entries()) {
      if (
        JSON.stringify(attachment) !==
        JSON.stringify(parts[position].attachment)
      ) {
        throw new DomainError(
          'RESOURCE_CHANGED',
          'Message attachment metadata does not match the stored snapshot',
        )
      }
      transaction
        .prepare(
          'INSERT INTO message_attachments(message_id, attachment_id, position) VALUES(?,?,?)',
        )
        .run(record.id, attachment.id, position)
    }
  }

  /** Adds durable draft protection without releasing concurrently importing attachments. */
  retainDraft(
    transaction: PersistenceTransaction,
    projectId: ProjectId,
    draftKey: string,
    ids: readonly string[],
  ): void {
    this.require(transaction, projectId, ids)
    for (const id of ids)
      transaction
        .prepare(
          'INSERT INTO attachment_drafts(project_id, draft_key, attachment_id) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        )
        .run(projectId, draftKey, id)
  }

  /** Replaces one recovered draft's complete attachment reference set. */
  setDraft(
    transaction: PersistenceTransaction,
    projectId: ProjectId,
    draftKey: string,
    ids: readonly string[],
  ): void {
    this.require(transaction, projectId, ids)
    transaction
      .prepare(
        'DELETE FROM attachment_drafts WHERE project_id = ? AND draft_key = ?',
      )
      .run(projectId, draftKey)
    this.retainDraft(transaction, projectId, draftKey, ids)
  }

  /** Removes stale draft keys only after the renderer has recovered the whole project's drafts. */
  reconcileDrafts(
    transaction: PersistenceTransaction,
    projectId: ProjectId,
    drafts: readonly { key: string; ids: string[] }[],
  ): void {
    transaction
      .prepare('DELETE FROM attachment_drafts WHERE project_id = ?')
      .run(projectId)
    for (const draft of drafts) {
      const available = draft.ids.filter(
        (id) => this.get(transaction, id)?.projectId === projectId,
      )
      this.retainDraft(transaction, projectId, draft.key, available)
    }
  }

  /** Atomically tombstones a bounded batch that no message or draft still references. */
  markUnused(
    transaction: PersistenceTransaction,
    cutoff: number,
  ): Attachment[] {
    transaction
      .prepare(
        `UPDATE attachments SET status = 'deleting' WHERE id IN (
      SELECT id FROM attachments WHERE status = 'ready' AND created_at < ? AND ${UNUSED} LIMIT 128
    )`,
      )
      .run(cutoff)
    return transaction
      .prepare("SELECT id FROM attachments WHERE status = 'deleting' LIMIT 128")
      .all()
      .map((row) => this.get(transaction, String(row.id), true)!)
  }

  /** Finishes filesystem collection while preserving any newly retained record. */
  deleteCollected(transaction: PersistenceTransaction, id: string): void {
    transaction
      .prepare(
        `DELETE FROM attachments WHERE id = ? AND status = 'deleting' AND ${UNUSED}`,
      )
      .run(id)
  }
}
