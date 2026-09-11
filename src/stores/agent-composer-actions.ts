import type { useAgentRuntimeStore } from './agent-runtime'
import { IPC_VERSION } from '../../shared/channels'
import type { DurableRunStartPayload } from '../../shared/domain-state-api'
import type { ContextAttachmentKind } from '../../shared/context'
import type { SessionId } from '../../shared/ids'
import { useAgentReplicaStore } from './agent-replica'
import { useComposerDraftsStore, composerDraftKey } from './composer-drafts'
import { selectedDraftTarget } from './composer-draft-view'
import { useNotificationStore } from './notifications'
import {
  attachmentRefs,
  normalizeSendMessageOptions,
  parseMentionAttachments,
  messageText,
  originalUserRecord,
  requestId,
  type SendMessageOptions,
} from './agent-runtime-helpers'

type Runtime = ReturnType<typeof useAgentRuntimeStore>

function showOperationError(
  error: { code: string; message: string },
  sessionId?: SessionId,
): void {
  useNotificationStore().error({ ...error, sessionId })
}

/** Submits a captured composer draft and applies its acknowledgement without replacing later user work. */
export async function sendComposerMessage(
  runtime: Runtime,
  value: SendMessageOptions | Event = {},
): Promise<boolean> {
  const options = normalizeSendMessageOptions(value)
  const replica = useAgentReplicaStore()
  const project = replica.selectedProject
  const session = replica.selectedSession
  const drafts = useComposerDraftsStore()
  const target = selectedDraftTarget(replica)
  const draft = target ? drafts.capture(target) : undefined
  const navigationRevision = replica.navigationRevision
  const text = (options.text ?? draft?.text ?? '').trim()
  if (
    !runtime.canSend ||
    !window.agentApi ||
    !project ||
    !draft ||
    !text ||
    runtime.startPending ||
    runtime.activeRunId ||
    runtime.pendingApproval ||
    (session &&
      (runtime.carryoverStartingBySessionId[session.id] ||
        runtime.carryoversBySessionId[session.id]?.length))
  ) {
    return false
  }
  const attachments =
    options.includeContext === false
      ? []
      : [...draft.attachments, ...parseMentionAttachments(text)].filter(
          (attachment, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.kind === attachment.kind &&
                candidate.path === attachment.path,
            ) === index,
        )
  const sessionId = session?.id ?? (requestId('session') as SessionId)
  const selection = runtime.composerModelSelection
  const request: DurableRunStartPayload = session
    ? {
        version: IPC_VERSION,
        kind: 'existing_session',
        sessionId,
        message: text,
        context: { attachments: attachmentRefs(attachments) },
        clientRequestId: requestId('request'),
      }
    : {
        version: IPC_VERSION,
        kind: 'new_session',
        sessionId,
        projectId: project.id,
        title: text.replace(/\s+/gu, ' ').slice(0, 80),
        modelSelection: {
          providerId: selection.providerId,
          model: selection.model,
          reasoning: selection.reasoning,
        },
        permissionMode: runtime.mode,
        message: text,
        context: { attachments: attachmentRefs(attachments) },
        clientRequestId: requestId('request'),
      }
  const draftKey = composerDraftKey(draft.target)
  runtime.pendingDraftStarts[draftKey] = true
  drafts.flush()
  let result: Awaited<ReturnType<typeof window.agentApi.startRun>>
  try {
    result = await window.agentApi.startRun(request)
    if (!result.ok) {
      showOperationError(result.error, sessionId)
      return false
    }
    const runResult = result.value
    await runtime.applyRunStartResult(sessionId, runResult)
    if (options.clearInput !== false) drafts.replaceUnchanged(draft, '', [])
    const current = selectedDraftTarget(replica)
    if (
      replica.navigationRevision === navigationRevision &&
      current &&
      composerDraftKey(current) === draftKey
    ) {
      if (!session)
        drafts.move(draft.target, { projectId: project.id, sessionId })
      replica.selectedProjectId = project.id
      replica.selectedSessionId = sessionId
    }
    return true
  } catch (error) {
    showOperationError(
      {
        code: 'RUN_START_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to start the conversation.',
      },
      sessionId,
    )
    return false
  } finally {
    delete runtime.pendingDraftStarts[draftKey]
  }
}

/** Sends a text-only interjection and consumes only the unchanged originating draft. */
export async function sendComposerInterjection(
  runtime: Runtime,
): Promise<boolean> {
  const overlay = runtime.activeOverlay
  const replica = useAgentReplicaStore()
  const sessionId = replica.selectedSessionId
  const target = selectedDraftTarget(replica)
  const drafts = useComposerDraftsStore()
  const draft = target ? drafts.capture(target) : undefined
  const message = draft?.text.trim()
  if (!window.agentApi || !sessionId || !overlay?.runId || !message || !draft) {
    return false
  }
  const result = await window.agentApi.interjectRun({
    version: IPC_VERSION,
    sessionId,
    runId: overlay.runId,
    message,
    clientRequestId: requestId('interjection'),
  })
  if (!result.ok) {
    showOperationError(result.error, sessionId)
    return false
  }
  drafts.replaceUnchanged(draft, '', draft.attachments)
  return true
}

/** Restores a rewound user message only if its originating composer has not been edited meanwhile. */
export async function editComposerMessage(
  runtime: Runtime,
  messageId: string,
): Promise<boolean> {
  const replica = useAgentReplicaStore()
  const record = replica.selectedMessages.find(
    (candidate) => candidate.id === messageId,
  )
  if (!originalUserRecord(record)) {
    showOperationError(
      {
        code: 'VALIDATION_FAILED',
        message: 'Only an original visible user message can be edited.',
      },
      replica.selectedSessionId,
    )
    return false
  }
  const text = messageText(record)
  const attachments = record.metadata.attachments ?? []
  const drafts = useComposerDraftsStore()
  const target = selectedDraftTarget(replica)
  if (!target) return false
  const draft = drafts.capture(target)
  if (!(await runtime.rewindMessage(messageId))) return false
  drafts.replaceUnchanged(draft, text, attachments)
  return true
}

/** Adds picker results to the draft that opened the dialog even if another Session is now selected. */
export async function chooseComposerAttachment(
  kind: ContextAttachmentKind,
): Promise<void> {
  const target = selectedDraftTarget(useAgentReplicaStore())
  if (!window.agentApi || !target) return
  const drafts = useComposerDraftsStore()
  const draft = drafts.capture(target)
  const result = await window.agentApi.chooseWorkspaceContext({
    version: IPC_VERSION,
    projectId: target.projectId,
    kind,
  })
  if (!result.ok) {
    showOperationError(result.error)
    return
  }
  drafts.addAttachments(draft.target, result.value.attachments)
}
