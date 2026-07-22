import type { MessageId, SessionId } from '../../shared/ids'
import {
  assertMessageRecordSemantics,
  MessageRecordSchema,
  type MessageRecord,
} from '../../shared/message'
import { compileSchema } from '../schema-validator'
import {
  assertSchemaValue,
  booleanColumn,
  encodeJsonColumn,
  integerColumn,
  nullableStringColumn,
  parseJsonColumn,
  parseNullableJsonColumn,
  stringColumn,
} from './codec-helpers'

const validateMessageRecord = compileSchema(MessageRecordSchema)

export interface MessageRow {
  schema_version: number
  id: string
  session_id: string
  seq: number
  client_request_id: string | null
  kind: string
  parts_json: string
  normalized_reasoning_text: string | null
  provider_continuation_json: string | null
  model_route_json: string | null
  metadata_json: string | null
  in_history: number
  created_at: string
}

export function encodeMessageRow(record: MessageRecord): MessageRow {
  assertSchemaValue<MessageRecord>(
    validateMessageRecord,
    record,
    'MessageRecord',
  )
  assertMessageRecordSemantics(record)
  return {
    schema_version: record.schemaVersion,
    id: record.id,
    session_id: record.sessionId,
    seq: record.seq,
    client_request_id:
      record.kind === 'user_input' ? record.clientRequestId : null,
    kind: record.kind,
    parts_json: encodeJsonColumn(record.parts, 'messages.parts_json'),
    normalized_reasoning_text:
      record.kind === 'assistant_turn'
        ? (record.normalizedReasoningText ?? null)
        : null,
    provider_continuation_json:
      record.kind === 'assistant_turn' && record.providerContinuation
        ? encodeJsonColumn(
            record.providerContinuation,
            'messages.provider_continuation_json',
          )
        : null,
    model_route_json:
      record.kind === 'assistant_turn'
        ? encodeJsonColumn(record.modelRoute, 'messages.model_route_json')
        : null,
    metadata_json: record.metadata
      ? encodeJsonColumn(record.metadata, 'messages.metadata_json')
      : null,
    in_history: record.inHistory ? 1 : 0,
    created_at: record.createdAt,
  }
}

export function decodeMessageRow(row: Record<string, unknown>): MessageRecord {
  const clientRequestId = nullableStringColumn(
    row.client_request_id,
    'messages.client_request_id',
  )
  const normalizedReasoningText = nullableStringColumn(
    row.normalized_reasoning_text,
    'messages.normalized_reasoning_text',
  )
  const providerContinuation = parseNullableJsonColumn(
    row.provider_continuation_json,
    'messages.provider_continuation_json',
  )
  const modelRoute = parseNullableJsonColumn(
    row.model_route_json,
    'messages.model_route_json',
  )
  const metadata = parseNullableJsonColumn(
    row.metadata_json,
    'messages.metadata_json',
  )
  const record = {
    schemaVersion: integerColumn(row.schema_version, 'messages.schema_version'),
    id: stringColumn(row.id, 'messages.id') as MessageId,
    sessionId: stringColumn(row.session_id, 'messages.session_id') as SessionId,
    seq: integerColumn(row.seq, 'messages.seq'),
    kind: stringColumn(row.kind, 'messages.kind'),
    parts: parseJsonColumn(row.parts_json, 'messages.parts_json'),
    inHistory: booleanColumn(row.in_history, 'messages.in_history'),
    createdAt: stringColumn(row.created_at, 'messages.created_at'),
    ...(clientRequestId === null ? {} : { clientRequestId }),
    ...(normalizedReasoningText === null ? {} : { normalizedReasoningText }),
    ...(providerContinuation === null ? {} : { providerContinuation }),
    ...(modelRoute === null ? {} : { modelRoute }),
    ...(metadata === null ? {} : { metadata }),
  }
  assertSchemaValue<MessageRecord>(
    validateMessageRecord,
    record,
    'MessageRecord row',
  )
  assertMessageRecordSemantics(record)
  return record
}
