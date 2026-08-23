import type {
  AssistantActivity,
  ProviderRetryState,
  RunStatus,
} from '../../shared/agent-events'
import type {
  ContextAttachmentChip,
  ContextAttachmentKind,
  ContextAttachmentRef,
} from '../../shared/context'
import type { RunId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { TodoState } from '../../shared/todo'
import type {
  PendingApproval,
  ReviewedApproval,
  RunActivity,
  ToolActivity,
  UsageActivity,
} from './agent-types'

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'cancelled',
  'failed',
])

export interface UiInterjection {
  id: string
  content: string
  createdAt: string
  status: 'queued' | 'injected' | 'superseded' | 'carryover'
  injectedAfterToolBatchId?: string
}

export interface SessionOverlay {
  runId?: RunId
  status: RunStatus
  streamActivity?: AssistantActivity
  providerRetry?: ProviderRetryState
  text: string
  reasoning: string
  tools: ToolActivity[]
  usage: UsageActivity[]
  approval?: PendingApproval
  reviewedApproval?: ReviewedApproval
  goal?: GoalState
  plan?: PlanState
  todo?: TodoState
  interjections: UiInterjection[]
  terminalReloadRunId?: RunId
  lastEventSeq: number
  diagnostics: string[]
  order: number
}

export interface CarryoverInterjection {
  id: string
  runId: RunId
  content: string
  createdAt: string
}

export interface SendMessageOptions {
  text?: string
  includeContext?: boolean
  clearInput?: boolean
}

/** Creates a client request ID by combining the supplied prefix with a UUID. */
export function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

/** Extracts supported send-message options from a plain object or DOM event. */
export function normalizeSendMessageOptions(
  value: SendMessageOptions | Event = {},
): SendMessageOptions {
  if (!value || typeof value !== 'object') return {}
  if ('text' in value || 'includeContext' in value || 'clearInput' in value) {
    return value as SendMessageOptions
  }
  return {}
}

/** Parses unique @-mention attachment paths into renderer attachment chips. */
export function parseMentionAttachments(
  message: string,
): ContextAttachmentChip[] {
  const attachments: ContextAttachmentChip[] = []
  const seen = new Set<string>()
  const pattern = /(^|\s)@([^\s@]+)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(message))) {
    const raw = match[2]?.trim()
    if (!raw || /^https?:\/\//u.test(raw)) continue
    const normalized = raw.replace(/^["']|["']$/gu, '').replace(/\\/gu, '/')
    const kind: ContextAttachmentKind = normalized.endsWith('/')
      ? 'directory'
      : 'file'
    const path =
      kind === 'directory' ? normalized.replace(/\/+$/gu, '') : normalized
    const key = `${kind}:${path}`
    if (!path || seen.has(key)) continue
    seen.add(key)
    attachments.push({ kind, path, source: 'mention' })
  }
  return attachments
}

/** Projects attachment chips into the bridge-safe attachment reference shape. */
export function attachmentRefs(
  attachments: ContextAttachmentChip[],
): ContextAttachmentRef[] {
  return attachments.map(({ kind, path, source }) => ({ kind, path, source }))
}

/** Joins text parts from a message record into the text shown to the user. */
export function messageText(record: MessageRecord): string {
  return record.parts
    .filter(
      (
        part,
      ): part is Extract<(typeof record.parts)[number], { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n')
}

/** Narrows a message to a user-input record with its original request metadata. */
export function originalUserRecord(
  record: MessageRecord | undefined,
): record is Extract<MessageRecord, { kind: 'user_input' }> & {
  clientRequestId: string
  metadata: {
    schemaVersion: 1
    submission: { type: 'message' }
    attachments?: ContextAttachmentChip[]
  }
} {
  return Boolean(
    record &&
    record.kind === 'user_input' &&
    record.visibility === 'visible' &&
    'clientRequestId' in record &&
    record.metadata.submission.type === 'message',
  )
}

/** Extracts the final workspace directory name after normalizing path separators. */
export function projectName(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}

/** Creates the empty renderer overlay used before a run has produced live state. */
export function blankOverlay(): SessionOverlay {
  return {
    status: 'idle',
    text: '',
    reasoning: '',
    tools: [],
    usage: [],
    interjections: [],
    lastEventSeq: 0,
    diagnostics: [],
    order: 0,
  }
}

/** Resolves transient Provider activity and coarse Run status into one UI phase. */
export function resolveRunActivity(
  overlay: Pick<
    SessionOverlay,
    'approval' | 'providerRetry' | 'runId' | 'status' | 'streamActivity'
  >,
): RunActivity | undefined {
  if (!overlay.runId) return undefined
  if (overlay.approval) return 'awaiting_approval'
  if (overlay.providerRetry) return 'retrying_model'

  switch (overlay.status) {
    case 'idle':
    case 'calling_llm':
      if (overlay.streamActivity === 'reasoning') return 'reasoning'
      if (overlay.streamActivity === 'output') return 'output'
      if (overlay.streamActivity === 'tool_call') return 'calling_tool'
      return 'requesting_model'
    case 'evaluating_tools':
      return 'calling_tool'
    case 'running_tools':
      return 'executing_tool'
    case 'awaiting_approval':
      return 'awaiting_approval'
    case 'cancelling':
      return 'cancelling'
    case 'completed':
    case 'cancelled':
    case 'failed':
      return undefined
  }
}

/** Converts a runtime approval snapshot into the renderer's pending-approval model. */
export function pendingApprovalFromSnapshot(
  runtime: ActiveRunPublicSnapshot,
): PendingApproval | undefined {
  const approval = runtime.approval
  if (!approval) return undefined
  return {
    runId: runtime.runId,
    callId: approval.callId,
    kind: approval.kind,
    tool: approval.tool,
    args: approval.arguments,
    reason: approval.reason,
    signals: approval.policySignals,
    diff: approval.diff,
    diffHash: approval.diffHash,
    rememberable: approval.rememberable,
    rememberArgConstraints: approval.rememberArgConstraints,
    expiresAt: approval.expiresAt,
    status: 'requested',
    order: 1,
  }
}
