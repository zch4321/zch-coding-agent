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
  dateTimeColumn,
  encodeJsonColumn,
  integerColumn,
  nullableStringColumn,
  parseJsonColumn,
  parseNullableJsonColumn,
  stringColumn,
} from './codec-helpers'
import { PersistenceError } from './persistence-error'

const validateMessageRecord = compileSchema(MessageRecordSchema)

export interface MessageRow {
  schema_version: number
  id: string
  session_id: string
  seq: number
  client_request_id: string | null
  replayed_from_message_id: string | null
  derived_from_message_id: string | null
  kind: string
  parts_json: string
  normalized_reasoning_text: string | null
  provider_continuation_json: string | null
  model_route_json: string | null
  metadata_json: string | null
  visibility: string
  turn_id: string | null
  in_history: number
  created_at: string
}

/** Returns or updates encode message row state. */
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
      record.kind === 'user_input' && 'clientRequestId' in record
        ? record.clientRequestId
        : null,
    replayed_from_message_id:
      record.kind === 'user_input' &&
      record.metadata &&
      'replayedFromMessageId' in record.metadata
        ? record.metadata.replayedFromMessageId
        : null,
    derived_from_message_id:
      record.kind === 'user_input' &&
      record.metadata &&
      'derivedFromMessageId' in record.metadata
        ? record.metadata.derivedFromMessageId
        : null,
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
    visibility: record.visibility,
    turn_id: record.turnId ?? null,
    in_history: record.inHistory ? 1 : 0,
    created_at: dateTimeColumn(record.createdAt, 'messages.created_at'),
  }
}

/** Returns or updates decode message row state. */
export function decodeMessageRow(row: Record<string, unknown>): MessageRecord {
  const clientRequestId = nullableStringColumn(
    row.client_request_id,
    'messages.client_request_id',
  )
  const replayedFromMessageId = nullableStringColumn(
    row.replayed_from_message_id,
    'messages.replayed_from_message_id',
  )
  const derivedFromMessageId = nullableStringColumn(
    row.derived_from_message_id,
    'messages.derived_from_message_id',
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
  const turnId = nullableStringColumn(row.turn_id, 'messages.turn_id')
  const record = {
    schemaVersion: integerColumn(row.schema_version, 'messages.schema_version'),
    id: stringColumn(row.id, 'messages.id') as MessageId,
    sessionId: stringColumn(row.session_id, 'messages.session_id') as SessionId,
    seq: integerColumn(row.seq, 'messages.seq'),
    kind: stringColumn(row.kind, 'messages.kind'),
    parts: parseJsonColumn(row.parts_json, 'messages.parts_json'),
    visibility: stringColumn(row.visibility, 'messages.visibility'),
    inHistory: booleanColumn(row.in_history, 'messages.in_history'),
    createdAt: dateTimeColumn(row.created_at, 'messages.created_at'),
    ...(clientRequestId === null ? {} : { clientRequestId }),
    ...(normalizedReasoningText === null ? {} : { normalizedReasoningText }),
    ...(providerContinuation === null ? {} : { providerContinuation }),
    ...(modelRoute === null ? {} : { modelRoute }),
    ...(metadata === null ? {} : { metadata }),
    ...(turnId === null ? {} : { turnId: turnId as MessageId }),
  }
  assertSchemaValue<MessageRecord>(
    validateMessageRecord,
    record,
    'MessageRecord row',
  )
  assertMessageRecordSemantics(record)
  const metadataReplaySource =
    record.kind === 'user_input' &&
    record.metadata &&
    'replayedFromMessageId' in record.metadata
      ? record.metadata.replayedFromMessageId
      : null
  if (metadataReplaySource !== replayedFromMessageId) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Replayed user message source does not match metadata',
    )
  }
  const metadataDerivationSource =
    record.kind === 'user_input' &&
    record.metadata &&
    'derivedFromMessageId' in record.metadata
      ? record.metadata.derivedFromMessageId
      : null
  if (metadataDerivationSource !== derivedFromMessageId) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Derived user message source does not match metadata',
    )
  }
  return record
}
