import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { FilePrecondition } from '../agent/file-tool-types'

/**
 * Branded type for a tool call that has passed the permission pipeline. The
 * opaque brand can only be minted here (via {@link issueApprovedCall} in the
 * permission pipeline), so tool executors can trust that an ApprovedToolCall
 * was actually authorised rather than forged by the model.
 */
export const approvedCallBrand: unique symbol = Symbol('ApprovedToolCall')

export type ApprovedBy =
  | 'readonly'
  | 'policy'
  | 'model'
  | 'human'
  | 'remembered'
  | 'yolo'

export interface ApprovedToolCall {
  readonly [approvedCallBrand]: true
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly callId: CallId
  readonly toolId: string
  readonly args: JsonValue
  readonly argsHash: string
  readonly resourcePreconditions: readonly FilePrecondition[]
  readonly diffHash?: string
  readonly approvedBy: ApprovedBy
  readonly approvedAt: string
}
