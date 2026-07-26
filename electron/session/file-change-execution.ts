import type {
  FileChangeOperation,
  FileChangeSummary,
} from '../../shared/file-change'
import type {
  CallId,
  FileChangeId,
  MessageId,
  SessionId,
} from '../../shared/ids'
import type { ApprovedToolCall } from '../tools/approved-tool-call'

export interface PreparedFileChange {
  id: FileChangeId
  sessionId: SessionId
  assistantMessageId: MessageId
  callId: CallId
  path: string
  operation: FileChangeOperation
  diff: string
  diffHash: string
  diffTruncated: boolean
  beforeExists: boolean
  beforeMode: number | null
  beforeHash: string
  beforeContent: string | null
  afterExists: boolean
  afterHash: string
  payloadBytes: number
  maximumPayloadBytes: number
}

export type FileChangeMutationOutcome =
  | {
      status: 'recorded'
      fileChange: FileChangeSummary
    }
  | {
      status: 'warning'
      warningCode:
        | 'CHANGE_HISTORY_PERSIST_FAILED'
        | 'CHANGE_HISTORY_AFTER_STATE_MISMATCH'
    }

/** Reports failures while preparing, applying, or recording a file-change tool operation. */
export class FileChangeExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'FileChangeExecutionError'
  }
}

export interface FileChangeExecutionPort {
  prepareMutation(input: {
    sessionId: SessionId
    assistantMessageId: MessageId
    workspace: string
    approvedCall: ApprovedToolCall
    diff: string
    maximumPayloadBytes: number
  }): Promise<PreparedFileChange | undefined>

  commitMutation(input: {
    workspace: string
    prepared: PreparedFileChange
  }): Promise<FileChangeMutationOutcome>
}
