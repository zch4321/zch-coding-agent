import type { MessageId, SessionId } from '../../shared/ids'
import {
  isControlCommandUserInput,
  type MessageRecord,
} from '../../shared/message'
import { ApplicationError } from './application-error'

/** Finds the last message sequence belonging to the assistant's terminal-tool batch. */
export function terminalToolBatchEnd(
  records: readonly MessageRecord[],
  assistantSeq: number,
): number {
  const assistant = records.find((record) => record.seq === assistantSeq)
  if (assistant?.kind !== 'assistant_turn') return assistantSeq
  const pending = assistant.parts.flatMap((part) =>
    part.type === 'tool_call' ? [part.callId] : [],
  )
  if (pending.length === 0) return assistantSeq
  let cursor = assistantSeq
  for (const callId of pending) {
    cursor += 1
    const result = records.find((record) => record.seq === cursor)
    if (result?.kind !== 'tool_result' || result.parts[0].callId !== callId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork point assistant does not have a complete terminal tool batch',
      )
    }
  }
  return cursor
}

/** Clones a message for a forked Session while remapping IDs and sequence references. */
export function cloneForkMessage(
  source: MessageRecord,
  sessionId: SessionId,
  idMap: ReadonlyMap<MessageId, MessageId>,
  seqMap: ReadonlyMap<number, number>,
  seq: number,
): MessageRecord {
  const record = structuredClone(source)
  const id = idMap.get(source.id)
  if (!id) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Fork message id map is incomplete',
    )
  }
  const clone = {
    ...record,
    id,
    sessionId,
    seq,
    visibility: source.visibility,
    inHistory: false,
    ...(source.turnId ? { turnId: idMap.get(source.turnId) } : {}),
  }
  if (source.turnId && !clone.turnId) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Fork turn reference leaves the copied Session',
    )
  }
  if (clone.kind === 'compact_summary') {
    const boundary = [...seqMap.entries()]
      .filter(
        ([sourceSeq]) => sourceSeq <= clone.metadata.compact.replacesThroughSeq,
      )
      .map(([, targetSeq]) => targetSeq)
      .at(-1)
    if (!boundary) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork compact boundary leaves the copied Session',
      )
    }
    return {
      ...clone,
      metadata: {
        ...clone.metadata,
        compact: {
          ...clone.metadata.compact,
          replacesThroughSeq: boundary,
        },
      },
    }
  }
  if (
    clone.kind === 'user_input' &&
    clone.metadata &&
    'replayedFromMessageId' in clone.metadata
  ) {
    const replayedFromMessageId = idMap.get(
      clone.metadata.replayedFromMessageId,
    )
    if (!replayedFromMessageId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork replay reference leaves the copied Session',
      )
    }
    return {
      ...clone,
      metadata: {
        ...clone.metadata,
        replayedFromMessageId,
      },
    }
  }
  if (
    clone.kind === 'user_input' &&
    clone.metadata &&
    'derivedFromMessageId' in clone.metadata
  ) {
    const derivedFromMessageId = idMap.get(clone.metadata.derivedFromMessageId)
    if (!derivedFromMessageId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Fork derived reference leaves the copied Session',
      )
    }
    return {
      ...clone,
      metadata: {
        ...clone.metadata,
        derivedFromMessageId,
      },
    }
  }
  return clone
}

/** Computes the sequence boundary used for an after-message, before-message, or before-turn rewind. */
export function rewindBoundarySeq(
  records: readonly MessageRecord[],
  target: MessageRecord,
  boundary: 'after_message' | 'before_message' | 'before_turn',
): number {
  if (boundary === 'after_message') return target.seq
  if (boundary === 'before_message') return target.seq - 1
  const turnId = target.turnId ?? target.id
  const first = records.find(
    (record) => record.visibility !== 'superseded' && record.turnId === turnId,
  )
  return (first?.seq ?? target.seq) - 1
}

/** Rebuilds active-history flags and visibility after a branch is rewound. */
export function rebuildActiveBranch(
  records: MessageRecord[],
  throughSeq: number,
): void {
  const prefix = records.filter(
    (record) => record.seq <= throughSeq && record.visibility !== 'superseded',
  )
  const compact = [...prefix]
    .reverse()
    .find((record) => record.kind === 'compact_summary')
  const compactBoundary =
    compact?.kind === 'compact_summary'
      ? compact.metadata.compact.replacesThroughSeq
      : 0
  for (const record of records) {
    record.inHistory =
      record.seq <= throughSeq &&
      record.seq > compactBoundary &&
      record.visibility !== 'superseded' &&
      !isControlCommandUserInput(record)
  }
}
