import type { RunStatus } from '../../shared/agent-events'
import type {
  ContextAttachmentChip,
  ContextAttachmentKind,
  ContextAttachmentRef,
} from '../../shared/context'
import type { RunId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type {
  PendingApproval,
  ReviewedApproval,
  ToolActivity,
  UsageActivity,
} from './agent-types'

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'cancelled',
  'failed',
])

export interface SessionOverlay {
  runId?: RunId
  status: RunStatus
  text: string
  reasoning: string
  tools: ToolActivity[]
  usage: UsageActivity[]
  approval?: PendingApproval
  reviewedApproval?: ReviewedApproval
  goal?: GoalState
  plan?: PlanState
  interjections: ActiveRunPublicSnapshot['interjections']
  lastEventSeq: number
  diagnostics: string[]
  order: number
}

export interface SendMessageOptions {
  text?: string
  includeContext?: boolean
  clearInput?: boolean
}

export function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export function normalizeSendMessageOptions(
  value: SendMessageOptions | Event = {},
): SendMessageOptions {
  if (!value || typeof value !== 'object') return {}
  if ('text' in value || 'includeContext' in value || 'clearInput' in value) {
    return value as SendMessageOptions
  }
  return {}
}

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

export function attachmentRefs(
  attachments: ContextAttachmentChip[],
): ContextAttachmentRef[] {
  return attachments.map(({ kind, path, source }) => ({ kind, path, source }))
}

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

export function projectName(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}

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
