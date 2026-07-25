import { MAX_MESSAGE_PAGE_RECORDS } from '../../shared/durable'
import type { MessageId, SessionId } from '../../shared/ids'
import {
  assertMessagePageSemantics,
  isControlCommandUserInput,
  type MessagePage,
  type MessageRecord,
} from '../../shared/message'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import { decodeMessageRow, encodeMessageRow } from './message-codec'
import { PersistenceError } from './persistence-error'

const MESSAGE_COLUMNS = `
  schema_version, id, session_id, seq, client_request_id,
  replayed_from_message_id, derived_from_message_id, kind, parts_json,
  normalized_reasoning_text, provider_continuation_json, model_route_json,
  metadata_json, visibility, turn_id, in_history, created_at
`

export const MAX_MESSAGE_SEARCH_RESULTS = 100
export const MAX_MESSAGE_SEARCH_SCAN = 2_000

export interface MessagePageQuery {
  beforeSeq?: number
  limit?: number
}

export interface MessageSearchQuery {
  text: string
  limit?: number
  scanLimit?: number
}

export class MessageRepository {
  insert(transaction: PersistenceTransaction, record: MessageRecord): void {
    insertMessageRow(transaction, encodeMessageRow(record))
  }

  insertMany(
    transaction: PersistenceTransaction,
    records: readonly MessageRecord[],
  ): void {
    for (const record of records) this.insert(transaction, record)
  }

  findByClientRequestId(
    reader: PersistenceReader,
    sessionId: SessionId,
    clientRequestId: string,
  ): MessageRecord | undefined {
    const row = reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ? AND client_request_id = ?`,
      )
      .get(sessionId, clientRequestId)
    return row ? decodeMessageRow(row) : undefined
  }

  get(
    reader: PersistenceReader,
    sessionId: SessionId,
    messageId: MessageId,
  ): MessageRecord | undefined {
    const row = reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, messageId)
    return row ? decodeMessageRow(row) : undefined
  }

  listThrough(
    reader: PersistenceReader,
    sessionId: SessionId,
    throughSeq: number,
    limit: number,
  ): MessageRecord[] {
    const bounded = boundedLimit(limit, 513, 'Message prefix limit')
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 1) {
      throw new PersistenceError(
        'CODEC_INVALID',
        'Message prefix seq must be a positive safe integer',
      )
    }
    return reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ? AND seq <= ? AND visibility <> 'superseded'
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionId, throughSeq, bounded)
      .map(decodeMessageRow)
  }

  listPage(
    reader: PersistenceReader,
    sessionId: SessionId,
    query: MessagePageQuery = {},
  ): MessagePage {
    const limit = boundedLimit(
      query.limit ?? MAX_MESSAGE_PAGE_RECORDS,
      MAX_MESSAGE_PAGE_RECORDS,
      'Message page limit',
    )
    if (
      query.beforeSeq !== undefined &&
      (!Number.isSafeInteger(query.beforeSeq) || query.beforeSeq < 1)
    ) {
      throw new PersistenceError(
        'CODEC_INVALID',
        'Message beforeSeq must be a positive safe integer',
      )
    }
    const rows = query.beforeSeq
      ? reader
          .prepare(
            `SELECT ${MESSAGE_COLUMNS}
             FROM messages
             WHERE session_id = ?
               AND seq < ?
               AND visibility <> 'superseded'
               AND (kind <> 'user_input' OR replayed_from_message_id IS NULL)
             ORDER BY seq DESC
             LIMIT ?`,
          )
          .all(sessionId, query.beforeSeq, limit + 1)
      : reader
          .prepare(
            `SELECT ${MESSAGE_COLUMNS}
             FROM messages
             WHERE session_id = ?
               AND visibility <> 'superseded'
               AND (kind <> 'user_input' OR replayed_from_message_id IS NULL)
             ORDER BY seq DESC
             LIMIT ?`,
          )
          .all(sessionId, limit + 1)
    const hasMore = rows.length > limit
    const records = rows.slice(0, limit).map(decodeMessageRow).reverse()
    const page: MessagePage = hasMore
      ? {
          schemaVersion: 1,
          sessionId,
          records,
          hasMore: true,
          nextBeforeSeq: records[0]!.seq,
        }
      : { schemaVersion: 1, sessionId, records, hasMore: false }
    assertMessagePageSemantics(page)
    return page
  }

  listActiveHistory(
    reader: PersistenceReader,
    sessionId: SessionId,
  ): MessageRecord[] {
    return reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ?
           AND visibility <> 'superseded'
           AND in_history = 1
         ORDER BY seq ASC`,
      )
      .all(sessionId)
      .map(decodeMessageRow)
  }

  searchText(
    reader: PersistenceReader,
    sessionId: SessionId,
    query: MessageSearchQuery,
  ): MessageRecord[] {
    const needle = query.text.trim().toLowerCase()
    if (needle.length === 0 || needle.length > 256) {
      throw new PersistenceError(
        'CODEC_INVALID',
        'Message search text must contain between 1 and 256 characters',
      )
    }
    const limit = boundedLimit(
      query.limit ?? MAX_MESSAGE_SEARCH_RESULTS,
      MAX_MESSAGE_SEARCH_RESULTS,
      'Message search result limit',
    )
    const scanLimit = boundedLimit(
      query.scanLimit ?? MAX_MESSAGE_SEARCH_SCAN,
      MAX_MESSAGE_SEARCH_SCAN,
      'Message search scan limit',
    )
    const candidates = reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ?
           AND kind IN ('user_input', 'assistant_turn')
           AND visibility = 'visible'
           AND (kind <> 'user_input' OR replayed_from_message_id IS NULL)
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(sessionId, scanLimit)
      .map(decodeMessageRow)

    return candidates
      .filter(
        (record) =>
          !isControlCommandUserInput(record) &&
          record.parts.some(
            (part) =>
              part.type === 'text' && part.text.toLowerCase().includes(needle),
          ),
      )
      .slice(0, limit)
  }

  setInHistoryThrough(
    transaction: PersistenceTransaction,
    sessionId: SessionId,
    throughSeq: number,
    inHistory: boolean,
  ): number {
    const result = transaction
      .prepare(
        `UPDATE messages
         SET in_history = ?
         WHERE session_id = ? AND seq <= ?`,
      )
      .run(inHistory ? 1 : 0, sessionId, throughSeq)
    return Number(result.changes)
  }

  listAll(reader: PersistenceReader, sessionId: SessionId): MessageRecord[] {
    return reader
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId)
      .map(decodeMessageRow)
  }

  updateBranchState(
    transaction: PersistenceTransaction,
    record: Pick<
      MessageRecord,
      'id' | 'sessionId' | 'visibility' | 'inHistory'
    >,
  ): void {
    const result = transaction
      .prepare(
        `UPDATE messages
         SET visibility = ?, in_history = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        record.visibility,
        record.inHistory ? 1 : 0,
        record.id,
        record.sessionId,
      )
    if (Number(result.changes) !== 1) {
      throw new PersistenceError(
        'DATABASE_CONSTRAINT',
        'Message branch state update lost its target',
      )
    }
  }
}

function insertMessageRow(
  transaction: PersistenceTransaction,
  row: ReturnType<typeof encodeMessageRow>,
): void {
  transaction
    .prepare(
      `INSERT INTO messages (
         schema_version, id, session_id, seq, client_request_id,
         replayed_from_message_id, derived_from_message_id, kind,
         parts_json, normalized_reasoning_text, provider_continuation_json,
         model_route_json, metadata_json, visibility, turn_id, in_history,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.schema_version,
      row.id,
      row.session_id,
      row.seq,
      row.client_request_id,
      row.replayed_from_message_id,
      row.derived_from_message_id,
      row.kind,
      row.parts_json,
      row.normalized_reasoning_text,
      row.provider_continuation_json,
      row.model_route_json,
      row.metadata_json,
      row.visibility,
      row.turn_id,
      row.in_history,
      row.created_at,
    )
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (Number.isInteger(value) && value >= 1 && value <= maximum) return value
  throw new PersistenceError(
    'CODEC_INVALID',
    `${label} must be between 1 and ${maximum}`,
  )
}
