import type { MessageRecord } from '../../shared/message'
import type { SessionRecord } from '../../shared/session'
import type { SessionState } from './session-types'

export type RuntimeSessionMetadata = Pick<
  SessionRecord,
  'permissionMode' | 'modelSelection' | 'goal' | 'plan'
>

export interface PreparedSessionCommit {
  records: MessageRecord[]
  metadata: RuntimeSessionMetadata
  metadataChanged: boolean
}

/** Selects new history and snapshots the same metadata for public and hidden Session commits. */
export function prepareSessionCommit(
  session: SessionState,
  durable: SessionRecord,
): PreparedSessionCommit {
  const metadata: RuntimeSessionMetadata = {
    permissionMode: session.mode,
    modelSelection: structuredClone(session.modelSelection),
    goal: session.goal ? structuredClone(session.goal) : null,
    plan: session.plan ? structuredClone(session.plan) : null,
  }
  return {
    records: session.history
      .filter((record) => record.seq > durable.lastSeq)
      .sort((left, right) => left.seq - right.seq),
    metadata,
    metadataChanged:
      metadata.permissionMode !== durable.permissionMode ||
      JSON.stringify(metadata.modelSelection) !==
        JSON.stringify(durable.modelSelection) ||
      JSON.stringify(metadata.goal) !== JSON.stringify(durable.goal) ||
      JSON.stringify(metadata.plan) !== JSON.stringify(durable.plan),
  }
}

/** Restores all runtime-owned durable fields after a failed public or hidden Session commit. */
export function restoreDurableSessionState(
  session: SessionState,
  durable: { record: SessionRecord; activeHistory: MessageRecord[] },
): void {
  session.history = structuredClone(durable.activeHistory)
  session.nextMessageSeq = durable.record.lastSeq + 1
  session.mode = durable.record.permissionMode
  session.provider = durable.record.modelSelection.providerId
  session.modelSelection = structuredClone(durable.record.modelSelection)
  session.modelSelectionPinned = true
  session.goal = durable.record.goal
    ? structuredClone(durable.record.goal)
    : undefined
  session.plan = durable.record.plan
    ? structuredClone(durable.record.plan)
    : undefined
}
