import type { MessageId } from './ids'
import { isControlCommandUserInput, type MessageRecord } from './message'

const PASSIVE_PROMPT_KINDS = new Set<MessageRecord['kind']>([
  'system_instruction',
  'assistant_preferences',
  'selected_context',
  'runtime_context',
  'agents_context',
])

export interface ManualContinuationTarget {
  rootUserMessageId: MessageId
  anchorMessageId: MessageId
}

/** Resolves the interrupted turn that can resume without appending user input. */
export function resolveManualContinuationTarget(
  records: readonly MessageRecord[],
): ManualContinuationTarget | undefined {
  const active = records
    .filter((record) => record.inHistory)
    .sort((left, right) => right.seq - left.seq)

  for (const record of active) {
    if (PASSIVE_PROMPT_KINDS.has(record.kind)) continue

    if (record.kind === 'user_input') {
      if (isControlCommandUserInput(record)) return undefined
      return {
        rootUserMessageId: record.turnId ?? record.id,
        anchorMessageId: record.id,
      }
    }

    if (
      record.kind === 'tool_result' ||
      record.kind === 'interjection' ||
      record.kind === 'orchestrator'
    ) {
      return {
        rootUserMessageId: record.turnId ?? record.id,
        anchorMessageId: record.id,
      }
    }

    if (record.kind === 'compact_summary' && record.turnId) {
      return {
        rootUserMessageId: record.turnId,
        anchorMessageId: record.id,
      }
    }

    return undefined
  }

  return undefined
}
