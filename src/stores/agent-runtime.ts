import { defineStore } from 'pinia'
import type { AgentEvent, RunStatus } from '../../shared/agent-events'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AssistantLanguage,
  ConfigSection,
  PermissionMode,
  PublicConfig,
} from '../../shared/config'
import type {
  ContextAttachmentChip,
  ContextAttachmentKind,
  ContextAttachmentRef,
} from '../../shared/context'
import type { RunId, SessionId } from '../../shared/ids'
import type { PlanStatus } from '../../shared/orchestration'
import type {
  ChatMessage,
  ConversationRecord,
  PendingApproval,
} from './agent-types'
import { useAgentChangesStore } from './agent-changes'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import { useAgentTimelineStore } from './agent-timeline'
import { useAgentWorkbenchStore } from './agent-workbench'
import {
  carryoverFromMessages,
  handleRuntimeAgentEvent,
  type PendingCarryoverInterjection,
  type RuntimeEventTimeline,
} from './runtime-events'
import { requestId } from './workbench-persistence'

let persistTimer: number | undefined

interface SendMessageOptions {
  text?: string
  includeContext?: boolean
  clearInput?: boolean
}

function normalizeSendMessageOptions(
  value: SendMessageOptions | Event,
): SendMessageOptions {
  if (!value || typeof value !== 'object') return {}
  if ('text' in value || 'includeContext' in value || 'clearInput' in value) {
    return value as SendMessageOptions
  }
  return {}
}

function parseMentionAttachments(message: string): ContextAttachmentChip[] {
  const attachments: ContextAttachmentChip[] = []
  const seen = new Set<string>()
  const pattern = /(^|\s)@([^\s@]+)/gu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(message))) {
    const raw = match[2]?.trim()
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) {
      continue
    }

    const normalizedPath = raw.replace(/^["']|["']$/gu, '').replace(/\\/gu, '/')
    const kind: ContextAttachmentKind = normalizedPath.endsWith('/')
      ? 'directory'
      : 'file'
    const path =
      kind === 'directory'
        ? normalizedPath.replace(/\/+$/gu, '')
        : normalizedPath
    const key = `${kind}:${path}`
    if (!path || seen.has(key)) continue
    seen.add(key)
    attachments.push({ kind, path, source: 'mention' })
  }

  return attachments
}

function attachmentRefs(
  attachments: ContextAttachmentChip[],
): ContextAttachmentRef[] {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    path: attachment.path,
    source: attachment.source,
  }))
}

interface ConversationRuntimeState {
  conversationId: string
  sessionId: SessionId | undefined
  activeRunId: RunId | undefined
  runStatus: RunStatus | 'idle'
  startPending: boolean
  pendingApproval: PendingApproval | undefined
  pendingCarryover: PendingCarryoverInterjection[]
  error: string
  modeSyncError: string
  lastEventSessionId: SessionId | undefined
  lastEventSeq: number
  diagnostics: string[]
  timelineCounter: number
}

interface WorkspaceWriterState {
  workspace: string
  writerConversationId: string
  writerSessionId: SessionId
  writerRunId: RunId
}

function createConversationRuntime(
  conversationId: string,
): ConversationRuntimeState {
  return {
    conversationId,
    sessionId: undefined,
    activeRunId: undefined,
    runStatus: 'idle',
    startPending: false,
    pendingApproval: undefined,
    pendingCarryover: [],
    error: '',
    modeSyncError: '',
    lastEventSessionId: undefined,
    lastEventSeq: 0,
    diagnostics: [],
    timelineCounter: 0,
  }
}

function runtimeBusy(runtime: ConversationRuntimeState | undefined): boolean {
  return Boolean(
    runtime?.startPending || runtime?.activeRunId || runtime?.pendingApproval,
  )
}

function conversationTimelineCounter(
  conversation: ConversationRecord,
  pendingApproval?: PendingApproval,
): number {
  return Math.max(
    conversation.messages.reduce(
      (maximum, message) => Math.max(maximum, message.order ?? 0),
      0,
    ),
    (conversation.tools ?? []).reduce(
      (maximum, tool) => Math.max(maximum, tool.order ?? 0),
      0,
    ),
    (conversation.usage ?? []).reduce(
      (maximum, item) => Math.max(maximum, item.order ?? 0),
      0,
    ),
    pendingApproval?.order ?? 0,
  )
}

function timelineAdapterFromConversation(
  conversation: ConversationRecord,
  runtime: ConversationRuntimeState,
): RuntimeEventTimeline {
  conversation.tools ??= []
  conversation.usage ??= []
  runtime.timelineCounter = Math.max(
    runtime.timelineCounter,
    conversationTimelineCounter(conversation, runtime.pendingApproval),
  )

  const adapter: RuntimeEventTimeline = {
    get messages() {
      return conversation.messages
    },
    set messages(value) {
      conversation.messages = value
    },
    get tools() {
      return conversation.tools ?? []
    },
    set tools(value) {
      conversation.tools = value
    },
    get usage() {
      return conversation.usage ?? []
    },
    set usage(value) {
      conversation.usage = value
    },
    get goal() {
      return conversation.goal
    },
    set goal(value) {
      conversation.goal = value
    },
    get plan() {
      return conversation.plan
    },
    set plan(value) {
      conversation.plan = value
    },
    get latestReviewedApproval() {
      return conversation.latestReviewedApproval
    },
    set latestReviewedApproval(value) {
      conversation.latestReviewedApproval = value
    },
    assistantMessage(runId: RunId): ChatMessage {
      const latestToolOrder = adapter.tools.reduce(
        (maximum, tool) =>
          tool.runId === runId ? Math.max(maximum, tool.order ?? 0) : maximum,
        0,
      )
      let message = adapter.messages
        .filter((item) => item.role === 'assistant' && item.runId === runId)
        .sort((left, right) => (right.order ?? 0) - (left.order ?? 0))[0]

      if (!message || (message.order ?? 0) < latestToolOrder) {
        message = {
          id: requestId(),
          role: 'assistant',
          runId,
          text: '',
          reasoning: '',
          order: adapter.nextTimelineOrder(),
        }
        adapter.messages.push(message)
      }
      return message
    },
    nextTimelineOrder(): number {
      runtime.timelineCounter += 1
      return runtime.timelineCounter
    },
  }
  return adapter
}

export const useAgentRuntimeStore = defineStore('agent-runtime', {
  state: () => ({
    globalError: '',
    conversationRuntimes: {} as Record<string, ConversationRuntimeState>,
    conversationIdBySessionId: {} as Record<string, string>,
    workspaceWriters: {} as Record<string, WorkspaceWriterState>,
    diagnostics: [] as string[],
    mode: 'readonly' as PermissionMode,
  }),
  getters: {
    activeConversationRuntime(state): ConversationRuntimeState | undefined {
      const conversationId = useAgentWorkbenchStore().activeConversationId
      return conversationId
        ? state.conversationRuntimes[conversationId]
        : undefined
    },
    sessionId(): SessionId | undefined {
      return this.activeConversationRuntime?.sessionId
    },
    activeRunId(): RunId | undefined {
      return this.activeConversationRuntime?.activeRunId
    },
    startPending(): boolean {
      return this.activeConversationRuntime?.startPending ?? false
    },
    runStatus(): RunStatus | 'idle' {
      return this.activeConversationRuntime?.runStatus ?? 'idle'
    },
    pendingApproval(): PendingApproval | undefined {
      return this.activeConversationRuntime?.pendingApproval
    },
    pendingCarryover(): PendingCarryoverInterjection[] {
      return this.activeConversationRuntime?.pendingCarryover ?? []
    },
    error(): string {
      return this.activeConversationRuntime?.error || this.globalError
    },
    agentEventGap(state): string {
      return (
        this.activeConversationRuntime?.diagnostics.at(-1) ??
        state.diagnostics.at(-1) ??
        ''
      )
    },
    modeLockedByWriter(state): boolean {
      const conversation = useAgentWorkbenchStore().activeConversation
      if (!conversation) return false
      const writer = state.workspaceWriters[conversation.projectPath]
      return Boolean(writer && writer.writerConversationId !== conversation.id)
    },
    modeLockTooltip(state): string {
      const conversation = useAgentWorkbenchStore().activeConversation
      if (!conversation) return ''
      const writer = state.workspaceWriters[conversation.projectPath]
      return writer && writer.writerConversationId !== conversation.id
        ? `Conversation ${writer.writerConversationId} is modifying this workspace.`
        : ''
    },
    modeSyncError(): string {
      return this.activeConversationRuntime?.modeSyncError ?? ''
    },
    approvalSubmitting(): boolean {
      return this.pendingApproval?.status === 'submitting'
    },
    canSend: (state) => {
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      const workbench = useAgentWorkbenchStore()
      const timeline = useAgentTimelineStore()
      const conversationId = workbench.activeConversationId
      const runtime = conversationId
        ? state.conversationRuntimes[conversationId]
        : undefined
      return Boolean(
        shell.bridgeAvailable &&
        settings.providerNoticeAccepted &&
        settings.credentialConfigured &&
        workbench.workspacePath &&
        workbench.activeConversationId &&
        !runtimeBusy(runtime) &&
        !runtime?.modeSyncError &&
        (timeline.input.trim().length > 0 ||
          timeline.contextAttachments.length > 0) &&
        !runtime?.pendingApproval,
      )
    },
    canInterject: (state) => {
      const shell = useAgentShellStore()
      const timeline = useAgentTimelineStore()
      const conversationId = useAgentWorkbenchStore().activeConversationId
      const runtime = conversationId
        ? state.conversationRuntimes[conversationId]
        : undefined
      // Interjections are allowed while a run is in progress, including while
      // it is paused on an approval. They queue and inject at the next
      // tool-batch boundary; they never cancel the run or the approval.
      const blockingApproval =
        runtime?.pendingApproval?.status === 'submitting' ||
        (runtime?.pendingApproval?.status === 'requested' &&
          runtime.runStatus !== 'awaiting_approval')
      return Boolean(
        shell.bridgeAvailable &&
        runtime?.sessionId &&
        runtime.activeRunId &&
        runtime.runStatus !== 'cancelling' &&
        !blockingApproval &&
        timeline.input.trim().length > 0,
      )
    },
  },
  actions: {
    ensureConversationRuntime(
      conversationId: string,
    ): ConversationRuntimeState {
      const existing = this.conversationRuntimes[conversationId]
      if (existing) return existing

      const runtime = createConversationRuntime(conversationId)
      const conversation = useAgentWorkbenchStore().conversations.find(
        (item) => item.id === conversationId,
      )
      if (conversation) {
        runtime.timelineCounter = conversationTimelineCounter(conversation)
      }
      this.conversationRuntimes[conversationId] = runtime
      return runtime
    },
    currentConversationRuntime(): ConversationRuntimeState | undefined {
      const workbench = useAgentWorkbenchStore()
      return workbench.activeConversationId
        ? this.ensureConversationRuntime(workbench.activeConversationId)
        : undefined
    },
    registerSession(conversationId: string, sessionId: SessionId) {
      const runtime = this.ensureConversationRuntime(conversationId)
      if (runtime.sessionId && runtime.sessionId !== sessionId) {
        delete this.conversationIdBySessionId[runtime.sessionId]
      }
      if (runtime.lastEventSessionId !== sessionId) {
        runtime.lastEventSessionId = sessionId
        runtime.lastEventSeq = 0
      }
      runtime.sessionId = sessionId
      this.conversationIdBySessionId[sessionId] = conversationId
    },
    registerRun(conversationId: string, runId: RunId) {
      const runtime = this.ensureConversationRuntime(conversationId)
      runtime.activeRunId = runId
      runtime.runStatus = 'calling_llm'
    },
    setStartPending(conversationId: string, pending: boolean) {
      this.ensureConversationRuntime(conversationId).startPending = pending
    },
    setConversationError(conversationId: string | undefined, message: string) {
      if (conversationId) {
        this.ensureConversationRuntime(conversationId).error = message
      } else {
        this.globalError = message
      }
    },
    addDiagnostic(conversationId: string | undefined, message: string) {
      const target = conversationId
        ? this.ensureConversationRuntime(conversationId).diagnostics
        : this.diagnostics
      target.push(message)
      if (target.length > 100) target.splice(0, target.length - 100)
    },
    clearDiagnostics() {
      this.diagnostics = []
      const runtime = this.currentConversationRuntime()
      if (runtime) runtime.diagnostics = []
    },
    currentConversationIsBusy(): boolean {
      const workbench = useAgentWorkbenchStore()
      const conversationId = workbench.activeConversationId
      if (!conversationId) return false
      return this.conversationIsBusy(conversationId)
    },
    conversationIsBusy(conversationId: string): boolean {
      const runtime = this.conversationRuntimes[conversationId]
      return runtimeBusy(runtime)
    },
    conversationStatus(
      conversationId: string,
    ):
      | 'awaitingApproval'
      | 'writer'
      | 'readonlyLocked'
      | 'cancelling'
      | 'running'
      | 'failed'
      | 'completed'
      | undefined {
      const runtime = this.conversationRuntimes[conversationId]
      const conversation = useAgentWorkbenchStore().conversations.find(
        (item) => item.id === conversationId,
      )
      if (runtime?.pendingApproval) return 'awaitingApproval'
      if (conversation) {
        const writer = this.workspaceWriters[conversation.projectPath]
        if (writer?.writerConversationId === conversationId) return 'writer'
        if (writer) return 'readonlyLocked'
      }
      if (runtime?.runStatus === 'cancelling') return 'cancelling'
      if (runtime?.startPending || runtime?.activeRunId) return 'running'
      if (runtime?.runStatus === 'failed') return 'failed'
      if (runtime?.runStatus === 'completed') return 'completed'
      return undefined
    },
    conversationIdForSession(sessionId: SessionId): string | undefined {
      const indexed = this.conversationIdBySessionId[sessionId]
      if (indexed) return indexed
      return undefined
    },
    async initialize() {
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      const workbench = useAgentWorkbenchStore()
      if (shell.initialized) return

      await workbench.loadPersistedWorkbench()
      const bridge = window.agentApi
      shell.bridgeAvailable = Boolean(bridge)

      if (!bridge) {
        this.restoreActiveConversation()
        shell.initialized = true
        return
      }

      const result = await bridge.getConfig({
        version: IPC_VERSION,
        section: 'all',
      })
      if (result.ok) {
        this.applyConfig(result.value.config)
        workbench.workspacePath = result.value.config.workspace.lastOpened ?? ''

        if (workbench.workspacePath) {
          workbench.registerProject(workbench.workspacePath)
          const active = workbench.conversations.find(
            (conversation) =>
              conversation.id === workbench.activeConversationId &&
              conversation.projectPath === workbench.workspacePath,
          )
          const latest = workbench.conversations
            .filter(
              (conversation) =>
                conversation.projectPath === workbench.workspacePath,
            )
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0]

          if (active || latest) {
            workbench.activeConversationId = (active ?? latest)?.id
          } else {
            this.createConversation(workbench.workspacePath)
          }
        }
      } else {
        this.globalError = result.error.message
      }

      await settings.loadProviderModels(false)
      this.restoreActiveConversation()
      shell.registerUnsubscriber(
        bridge.onAgentEvent((envelope) =>
          this.handleAgentEvent(envelope.event),
        ),
      )
      shell.initialized = true
      workbench.persistWorkbench()
    },
    dispose() {
      const shell = useAgentShellStore()
      const workbench = useAgentWorkbenchStore()
      if (persistTimer !== undefined) {
        window.clearTimeout(persistTimer)
        persistTimer = undefined
      }
      this.saveActiveConversation()
      workbench.persistWorkbench()
      shell.disposeSubscriptions()
    },
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      const settings = useAgentSettingsStore()
      const workbench = useAgentWorkbenchStore()
      settings.applyConfig(config, sections)
      const includesPermission =
        sections.includes('all') || sections.includes('permission')
      if (includesPermission && !workbench.activeConversationId) {
        this.mode = config.permission.defaultMode
      }
    },
    createConversation(workspacePath?: string) {
      const settings = useAgentSettingsStore()
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const changes = useAgentChangesStore()
      const targetWorkspace = workspacePath ?? workbench.workspacePath
      if (!targetWorkspace) return undefined

      const conversation = workbench.createConversationRecord(
        targetWorkspace,
        settings.activeProviderModel,
        this.workspaceWriters[targetWorkspace] ? 'readonly' : this.mode,
      )
      const runtime = this.ensureConversationRuntime(conversation.id)
      runtime.sessionId = undefined
      runtime.activeRunId = undefined
      runtime.runStatus = 'idle'
      runtime.startPending = false
      runtime.pendingApproval = undefined
      runtime.pendingCarryover = []
      runtime.error = ''
      runtime.modeSyncError = ''
      timeline.reset()
      changes.reset()
      workbench.persistWorkbench()
      return conversation
    },
    async newConversation(workspacePath?: string) {
      const workbench = useAgentWorkbenchStore()
      if (!workspacePath && !workbench.workspacePath) {
        const selected = await this.chooseWorkspace()
        if (!selected) return false
        workspacePath = selected
      }

      this.saveActiveConversation()
      const targetWorkspace = workspacePath ?? workbench.workspacePath
      if (!targetWorkspace) return false

      if (
        targetWorkspace !== workbench.workspacePath &&
        !(await workbench.activateWorkspace(targetWorkspace))
      ) {
        return false
      }

      this.createConversation(targetWorkspace)
      return true
    },
    async selectConversation(conversationId: string) {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation || conversationId === workbench.activeConversationId) {
        return Boolean(conversation)
      }
      this.saveActiveConversation()
      if (!(await workbench.activateWorkspace(conversation.projectPath))) {
        return false
      }
      await this.ensureConversationReadonlyForWriter(conversationId)
      workbench.activeConversationId = conversation.id
      this.restoreActiveConversation()
      workbench.persistWorkbench()
      return true
    },
    async ensureConversationReadonlyForWriter(
      conversationId: string,
    ): Promise<boolean> {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation) return false

      const writer = this.workspaceWriters[conversation.projectPath]
      if (!writer || writer.writerConversationId === conversationId) {
        return true
      }

      const runtime = this.ensureConversationRuntime(conversationId)
      conversation.mode = 'readonly'
      if (workbench.activeConversationId === conversationId) {
        this.mode = 'readonly'
      }
      runtime.modeSyncError = ''
      this.scheduleWorkbenchSave()

      if (
        !runtime.sessionId ||
        runtime.activeRunId ||
        runtime.pendingApproval
      ) {
        return true
      }
      const bridge = window.agentApi
      if (!bridge) return true

      const targetSessionId = runtime.sessionId
      const result = await bridge.updateSessionMode({
        version: IPC_VERSION,
        sessionId: targetSessionId,
        mode: 'readonly',
      })
      if (runtime.sessionId !== targetSessionId) return false
      if (result.ok && result.value.accepted) return true

      runtime.modeSyncError = result.ok
        ? 'Could not synchronize the session to readonly mode.'
        : result.error.message
      runtime.error = runtime.modeSyncError
      return false
    },
    renameConversation(conversationId: string, title: string) {
      useAgentWorkbenchStore().renameConversation(conversationId, title)
    },
    /**
     * Fork the active conversation (or a specific one) into a new branch. The
     * new branch becomes active, truncated at forkPointMessageId (inclusive).
     * Runs are blocked while forking; the forked conversation starts without a
     * live session, so the next sendMessage creates a fresh session.
     */
    async forkConversation(
      sourceId?: string,
      forkPointMessageId?: string,
    ): Promise<boolean> {
      const workbench = useAgentWorkbenchStore()
      const timeline = useAgentTimelineStore()
      const changes = useAgentChangesStore()
      const source =
        workbench.conversations.find(
          (item) => item.id === (sourceId ?? workbench.activeConversationId),
        ) ?? workbench.activeConversation
      if (!source || this.conversationIsBusy(source.id)) return false

      const forked = workbench.forkConversation(source.id, forkPointMessageId)
      if (!forked) return false

      this.ensureConversationRuntime(forked.id)
      timeline.reset()
      changes.reset()
      this.restoreActiveConversation()
      return true
    },
    /**
     * 回退对话 (in-place): remove every message after the agent reply with
     * keepMessageId (and the tools/usage/orchestrator updates recorded after
     * it), keeping the conversation itself. The old runtime session is closed
     * because its history no longer matches; the next send creates a fresh one.
     */
    async revertConversationAfterMessage(
      keepMessageId: string,
    ): Promise<boolean> {
      const workbench = useAgentWorkbenchStore()
      const timeline = useAgentTimelineStore()
      const changes = useAgentChangesStore()
      const conversation = workbench.activeConversation
      if (!conversation || this.conversationIsBusy(conversation.id))
        return false

      const updated = workbench.revertConversationAfterMessage(
        conversation.id,
        keepMessageId,
      )
      if (!updated) return false

      // The history changed, so the live session is stale and must be closed.
      await this.closeRuntimeSession(conversation.id)
      timeline.reset()
      changes.reset()
      this.restoreActiveConversation()
      return true
    },
    async deleteConversation(conversationId: string) {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation || this.conversationIsBusy(conversationId)) {
        return false
      }

      if (this.conversationRuntimes[conversationId]?.sessionId) {
        await this.closeRuntimeSession(conversationId)
      }
      workbench.removeConversationRecord(conversationId)
      const runtime = this.conversationRuntimes[conversationId]
      if (runtime?.sessionId) {
        delete this.conversationIdBySessionId[runtime.sessionId]
      }
      delete this.conversationRuntimes[conversationId]

      if (conversationId === workbench.activeConversationId) {
        const next = workbench.conversations
          .filter((item) => item.projectPath === conversation.projectPath)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          )[0]
        workbench.activeConversationId = next?.id
        if (!next && workbench.workspacePath) {
          this.createConversation(workbench.workspacePath)
        } else {
          this.restoreActiveConversation()
        }
      }

      workbench.persistWorkbench()
      return true
    },
    async removeCurrentProject() {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const changes = useAgentChangesStore()
      if (
        !workbench.workspacePath ||
        workbench.conversations
          .filter(
            (conversation) =>
              conversation.projectPath === workbench.workspacePath,
          )
          .some((conversation) => this.conversationIsBusy(conversation.id))
      ) {
        return false
      }

      const removedPath = workbench.workspacePath
      const projectConversationIds = workbench.conversations
        .filter((conversation) => conversation.projectPath === removedPath)
        .map((conversation) => conversation.id)
      await Promise.all(
        projectConversationIds.map((conversationId) =>
          this.closeRuntimeSession(conversationId),
        ),
      )
      for (const conversationId of projectConversationIds) {
        delete this.conversationRuntimes[conversationId]
      }
      workbench.removeProjectRecords(removedPath)
      workbench.workspacePath = ''
      workbench.activeConversationId = undefined
      timeline.reset()
      changes.reset()

      const bridge = window.agentApi
      if (bridge) {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'workspace',
        })
        if (!result.ok) this.globalError = result.error.message
      }
      workbench.persistWorkbench()
      return true
    },
    restoreActiveConversation() {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const changes = useAgentChangesStore()
      const conversation = workbench.activeConversation
      timeline.hydrate(conversation)

      if (conversation) {
        workbench.workspacePath = conversation.projectPath
        this.mode = conversation.mode
        const runtime = this.ensureConversationRuntime(conversation.id)
        if (runtime.sessionId) {
          this.conversationIdBySessionId[runtime.sessionId] = conversation.id
        }
        runtime.timelineCounter = Math.max(
          runtime.timelineCounter,
          conversationTimelineCounter(conversation, runtime.pendingApproval),
          timeline.timelineCounter,
        )
        if (!runtime.activeRunId && !runtime.pendingApproval) {
          runtime.pendingCarryover = carryoverFromMessages(timeline.messages)
        }
      }
      changes.reset()
      if (conversation && window.agentApi?.listChanges) {
        void changes.loadConversationChanges()
      }
      useAgentShellStore().error = ''
      useAgentSettingsStore().error = ''
      workbench.error = ''
      changes.error = ''
      if (conversation) {
        this.ensureConversationRuntime(conversation.id).error ||= ''
      }
      if (!this.activeRunId && this.pendingCarryover.length > 0) {
        void this.flushCarryoverInterjections()
      }
    },
    saveActiveConversation(touchUpdatedAt = false) {
      const settings = useAgentSettingsStore()
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.activeConversation
      if (!conversation) return

      timeline.writeToConversation(conversation)
      const runtime = this.ensureConversationRuntime(conversation.id)
      runtime.timelineCounter = Math.max(
        runtime.timelineCounter,
        timeline.timelineCounter,
        runtime.pendingApproval?.order ?? 0,
      )
      conversation.mode = this.mode
      conversation.model = settings.activeProviderModel
      if (touchUpdatedAt) conversation.updatedAt = new Date().toISOString()
    },
    schedulePersist(touchUpdatedAt = true) {
      this.saveActiveConversation(touchUpdatedAt)
      this.scheduleWorkbenchSave()
    },
    scheduleWorkbenchSave() {
      const workbench = useAgentWorkbenchStore()
      if (persistTimer !== undefined) window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(() => {
        workbench.persistWorkbench()
        persistTimer = undefined
      }, 250)
    },
    timelineForConversation(
      conversationId: string,
    ): RuntimeEventTimeline | undefined {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation) return undefined

      const runtime = this.ensureConversationRuntime(conversationId)
      if (workbench.activeConversationId === conversationId) {
        const timeline = useAgentTimelineStore()
        runtime.timelineCounter = Math.max(
          runtime.timelineCounter,
          timeline.timelineCounter,
          runtime.pendingApproval?.order ?? 0,
        )
        return timeline
      }
      return timelineAdapterFromConversation(conversation, runtime)
    },
    persistConversationMutation(conversationId: string, touchUpdatedAt = true) {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation) return
      if (workbench.activeConversationId === conversationId) {
        this.schedulePersist(touchUpdatedAt)
        return
      }
      if (touchUpdatedAt) conversation.updatedAt = new Date().toISOString()
      this.scheduleWorkbenchSave()
    },
    persistWorkbench() {
      useAgentWorkbenchStore().persistWorkbench()
    },
    async activateWorkspace(workspacePath: string) {
      return useAgentWorkbenchStore().activateWorkspace(workspacePath)
    },
    async saveAssistantSettings(language?: AssistantLanguage) {
      return useAgentSettingsStore().saveAssistantSettings(language)
    },
    async chooseWorkspace() {
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      if (!bridge) return undefined

      const result = await bridge.chooseWorkspace({ version: IPC_VERSION })
      if (!result.ok) {
        this.globalError = result.error.message
        return undefined
      }
      if (!result.value.path) return undefined

      workbench.workspacePath = result.value.path
      workbench.registerProject(result.value.path)
      const latest = workbench.conversations
        .filter(
          (conversation) => conversation.projectPath === result.value.path,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]

      if (latest) {
        workbench.activeConversationId = latest.id
        this.restoreActiveConversation()
      } else {
        this.createConversation(result.value.path)
      }
      workbench.persistWorkbench()
      return result.value.path
    },
    async setMode(mode: PermissionMode) {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.activeConversation
      if (!conversation) return false
      if (mode === conversation.mode) return true
      if (this.currentConversationIsBusy()) return false
      if (mode !== 'readonly' && this.modeLockedByWriter) return false

      const conversationId = conversation.id
      const runtime = this.ensureConversationRuntime(conversationId)
      const targetSessionId = runtime.sessionId
      const bridge = window.agentApi
      if (bridge && targetSessionId) {
        const result = await bridge.updateSessionMode({
          version: IPC_VERSION,
          sessionId: targetSessionId,
          mode,
        })
        if (!result.ok || !result.value.accepted) {
          runtime.error = result.ok
            ? result.value.reason === 'workspace_writer_active'
              ? `Conversation ${result.value.writerConversationId ?? 'unknown'} is modifying this workspace.`
              : 'The session could not change permission mode while a run is active.'
            : result.error.message
          return false
        }
      }
      conversation.mode = mode
      runtime.modeSyncError = ''
      runtime.error = ''
      if (workbench.activeConversationId === conversationId) this.mode = mode
      this.scheduleWorkbenchSave()
      return true
    },
    async updatePlanStatus(
      status: PlanStatus,
      conversationId = useAgentWorkbenchStore().activeConversationId,
    ) {
      const bridge = window.agentApi
      if (
        !bridge ||
        !conversationId ||
        this.conversationIsBusy(conversationId)
      ) {
        return false
      }
      const runtime = this.ensureConversationRuntime(conversationId)
      const sessionId = runtime.sessionId
      if (!sessionId) return false

      const result = await bridge.updatePlanStatus({
        version: IPC_VERSION,
        sessionId,
        status,
      })

      if (result.ok && result.value.accepted) {
        const targetTimeline = this.timelineForConversation(conversationId)
        if (!targetTimeline) return false
        targetTimeline.plan = result.value.plan
          ? structuredClone(result.value.plan)
          : undefined
        this.persistConversationMutation(conversationId, false)
        return true
      }

      runtime.error = result.ok
        ? 'The current plan state could not be changed.'
        : result.error.message
      return false
    },
    async approvePlan() {
      const settings = useAgentSettingsStore()
      const bridge = window.agentApi
      const conversationId = useAgentWorkbenchStore().activeConversationId
      const runtime = conversationId
        ? this.ensureConversationRuntime(conversationId)
        : undefined
      if (
        !bridge ||
        !conversationId ||
        !runtime?.sessionId ||
        !useAgentTimelineStore().plan ||
        this.conversationIsBusy(conversationId)
      ) {
        return false
      }

      if (!(await this.updatePlanStatus('active', conversationId))) return false

      const text =
        settings.assistantForm.language === 'zh-CN'
          ? '用户已批准当前计划。继续执行已激活的计划。'
          : 'The user approved the current plan. Continue executing the active plan.'
      return this.sendMessageForConversation(conversationId, {
        text,
        includeContext: false,
        clearInput: false,
      })
    },
    async rejectPlan() {
      return this.updatePlanStatus('rejected')
    },
    async createSession(
      conversationId = useAgentWorkbenchStore().activeConversationId,
    ) {
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!bridge || !conversation) return false

      const runtime = this.ensureConversationRuntime(conversation.id)
      runtime.error = ''
      const settings = useAgentSettingsStore()
      const result = await bridge.createSession({
        version: IPC_VERSION,
        conversationId: conversation.id,
        workspace: conversation.projectPath,
        mode: conversation.mode,
        provider: settings.activeProviderId,
      })
      if (result.ok) {
        this.registerSession(conversation.id, result.value.sessionId)
        return true
      }
      runtime.error = result.error.message
      return false
    },
    async closeRuntimeSession(conversationId?: string) {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const targetConversationId =
        conversationId ?? workbench.activeConversationId
      const sessionId = targetConversationId
        ? this.conversationRuntimes[targetConversationId]?.sessionId
        : undefined

      if (targetConversationId) {
        const runtime = this.conversationRuntimes[targetConversationId]
        if (runtime?.sessionId) {
          delete this.conversationIdBySessionId[runtime.sessionId]
        }
        if (runtime) {
          runtime.sessionId = undefined
          runtime.lastEventSessionId = undefined
          runtime.lastEventSeq = 0
          runtime.activeRunId = undefined
          runtime.startPending = false
          runtime.pendingApproval = undefined
          runtime.pendingCarryover = []
          runtime.runStatus = 'idle'
          runtime.error = ''
        }
      }
      if (targetConversationId === workbench.activeConversationId) {
        timeline.tools = []
      }

      const bridge = window.agentApi
      if (bridge && sessionId) {
        await bridge.closeSession({ version: IPC_VERSION, sessionId })
      }
    },
    async chooseContextAttachment(kind: ContextAttachmentKind) {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const conversationId = workbench.activeConversationId
      const workspace = workbench.workspacePath
      if (!bridge || !conversationId || !workspace) return false

      const result = await bridge.chooseWorkspaceContext({
        version: IPC_VERSION,
        workspace,
        kind,
      })

      if (!result.ok) {
        this.setConversationError(
          workbench.activeConversationId,
          result.error.message,
        )
        return false
      }

      if (
        workbench.activeConversationId !== conversationId ||
        workbench.workspacePath !== workspace
      ) {
        return false
      }

      timeline.addContextAttachments(result.value.attachments)
      return result.value.attachments.length > 0
    },
    async sendMessage(options: SendMessageOptions | Event = {}) {
      const sendOptions = normalizeSendMessageOptions(options)
      const workbench = useAgentWorkbenchStore()
      const conversationId = workbench.activeConversationId
      if (!conversationId) return false
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      if (
        !shell.bridgeAvailable ||
        !settings.providerNoticeAccepted ||
        !settings.credentialConfigured
      ) {
        return false
      }
      return this.sendMessageForConversation(conversationId, sendOptions)
    },
    async sendMessageForConversation(
      conversationId: string,
      sendOptions: SendMessageOptions = {},
    ) {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation) return false
      const runtime = this.ensureConversationRuntime(conversationId)
      const isActive = workbench.activeConversationId === conversationId
      const explicitText = sendOptions.text?.trim()
      const draftText = isActive ? timeline.input.trim() : ''
      const text =
        explicitText ||
        draftText ||
        'Please inspect the attached workspace context.'
      const hasUserInput =
        Boolean(explicitText || draftText) ||
        (isActive && timeline.contextAttachments.length > 0)
      const canStartRun = Boolean(
        bridge &&
        conversation.projectPath &&
        !runtimeBusy(runtime) &&
        !runtime.modeSyncError,
      )
      if (!bridge || !text || !hasUserInput || !canStartRun) return false
      runtime.startPending = true
      runtime.error = ''

      try {
        if (!(await this.ensureConversationReadonlyForWriter(conversationId))) {
          return false
        }
        if (!runtime.sessionId && !(await this.createSession(conversationId))) {
          return false
        }
        const sessionId = runtime.sessionId
        if (!sessionId) return false

        const includeContext = sendOptions.includeContext !== false
        const mentionAttachments = includeContext
          ? parseMentionAttachments(text)
          : []
        const contextAttachments = [
          ...(includeContext && isActive ? timeline.contextAttachments : []),
          ...mentionAttachments,
        ]
        const result = await bridge.startRun({
          version: IPC_VERSION,
          sessionId,
          message: text,
          clientRequestId: requestId(),
          ...(contextAttachments.length
            ? { context: { attachments: attachmentRefs(contextAttachments) } }
            : {}),
        })
        if (!result.ok) {
          runtime.error = result.error.message
          return false
        }

        const targetTimeline = this.timelineForConversation(conversationId)
        if (!targetTimeline) return false
        if (
          sendOptions.clearInput !== false &&
          workbench.activeConversationId === conversationId
        ) {
          timeline.input = ''
          timeline.clearContextAttachments()
        }
        targetTimeline.messages.push({
          id: requestId(),
          role: 'user',
          text,
          reasoning: '',
          attachments: contextAttachments.map((attachment) => ({
            ...attachment,
          })),
          order: targetTimeline.nextTimelineOrder(),
        })
        workbench.applyAutoTitle(conversation, text)
        if (conversation.transient) delete conversation.transient
        this.registerRun(conversationId, result.value.runId)
        this.persistConversationMutation(conversationId)
        return true
      } finally {
        runtime.startPending = false
      }
    },
    async sendInterjection() {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const text = timeline.input.trim()
      if (!bridge || !text || !this.canInterject) return
      const conversationId = workbench.activeConversationId
      if (!conversationId) return
      const runtime = this.ensureConversationRuntime(conversationId)
      const sessionId = runtime.sessionId
      const runId = runtime.activeRunId
      if (!sessionId || !runId) return

      const interjectionId = requestId()
      const result = await bridge.interjectRun({
        version: IPC_VERSION,
        sessionId,
        runId,
        message: text,
        clientRequestId: interjectionId,
      })

      if (result.ok && result.value.accepted) {
        const targetTimeline = this.timelineForConversation(conversationId)
        if (!targetTimeline) return
        // The interjection.updated event may have arrived before the IPC
        // result resolved (the main process emits it synchronously). Avoid a
        // duplicate by only pushing when no message for this id exists yet.
        const alreadyPresent = targetTimeline.messages.some(
          (item) => item.interjectionId === interjectionId,
        )
        if (!alreadyPresent) {
          targetTimeline.messages.push({
            id: requestId(),
            role: 'interjection',
            runId,
            text,
            reasoning: '',
            interjectionId,
            interjectionStatus: 'queued',
            order: targetTimeline.nextTimelineOrder(),
          })
        }
        if (workbench.activeConversationId === conversationId) {
          timeline.input = ''
          // Interjections are text-only. Clear any context chips so they do not
          // leak into the next ordinary user turn.
          timeline.clearContextAttachments()
        }
        this.persistConversationMutation(conversationId)
      } else if (!result.ok) {
        runtime.error = result.error.message
      }
    },
    async flushCarryoverInterjections(
      conversationId = useAgentWorkbenchStore().activeConversationId,
    ) {
      // Drain interjections that were carried over from a finished run's final
      // answer. Each becomes the next ordinary user turn. Only one is sent per
      // flush because sendMessage starts a new run; the rest drain when that
      // run terminates.
      if (!conversationId) return
      const runtime = this.ensureConversationRuntime(conversationId)
      if (runtimeBusy(runtime) || runtime.pendingCarryover.length === 0) return
      const pending = runtime.pendingCarryover[0]
      if (!pending) return
      const sent = await this.sendMessageForConversation(conversationId, {
        text: pending.content,
        includeContext: false,
        clearInput: false,
      })
      if (!sent) return
      runtime.pendingCarryover.shift()
      const targetTimeline = this.timelineForConversation(conversationId)
      if (!targetTimeline) return
      const index = targetTimeline.messages.findIndex(
        (item) =>
          item.role === 'interjection' &&
          item.interjectionId === pending.interjectionId,
      )
      if (index >= 0) {
        targetTimeline.messages.splice(index, 1)
        this.persistConversationMutation(conversationId)
      }
    },
    retryCarryoverInterjections() {
      for (const runtime of Object.values(this.conversationRuntimes)) {
        if (runtime.pendingCarryover.length > 0 && !runtimeBusy(runtime)) {
          void this.flushCarryoverInterjections(runtime.conversationId)
        }
      }
    },
    async interruptRun(
      conversationId = useAgentWorkbenchStore().activeConversationId,
    ) {
      const bridge = window.agentApi
      if (!bridge || !conversationId) return
      const runtime = this.ensureConversationRuntime(conversationId)
      const sessionId = runtime.sessionId
      const runId = runtime.activeRunId
      if (!sessionId || !runId) return
      await bridge.interruptRun({
        version: IPC_VERSION,
        sessionId,
        runId,
      })
    },
    async decideApproval(input: {
      conversationId: string
      decision: 'allow' | 'deny'
      remember?: boolean
    }) {
      const bridge = window.agentApi
      const runtime = this.ensureConversationRuntime(input.conversationId)
      const pendingApproval = runtime.pendingApproval
      if (
        !bridge ||
        !runtime.sessionId ||
        !pendingApproval ||
        pendingApproval.status === 'submitting'
      ) {
        return
      }

      const pending = pendingApproval
      pending.status = 'submitting'
      const rememberInput =
        input.decision === 'allow' && input.remember && pending.rememberable
          ? {
              workspaceScope: 'workspace' as const,
              expiresAt: new Date(
                Date.now() + 30 * 24 * 60 * 60_000,
              ).toISOString(),
            }
          : undefined
      const result = await bridge.decideApproval({
        version: IPC_VERSION,
        sessionId: runtime.sessionId,
        runId: pending.runId,
        callId: pending.callId,
        decision: input.decision,
        ...(rememberInput ? { remember: rememberInput } : {}),
      })

      if (result.ok && result.value.accepted) {
        const targetTimeline = this.timelineForConversation(
          input.conversationId,
        )
        if (!targetTimeline) return
        if (pending.diff) {
          targetTimeline.latestReviewedApproval = {
            runId: pending.runId,
            callId: pending.callId,
            tool: pending.tool,
            reason: pending.reason,
            diff: pending.diff,
            diffHash: pending.diffHash,
            decision: input.decision === 'allow' ? 'allowed' : 'denied',
          }
        }
        runtime.pendingApproval = undefined
        this.persistConversationMutation(input.conversationId)
      } else if (result.ok) {
        const targetTimeline = this.timelineForConversation(
          input.conversationId,
        )
        if (!targetTimeline) return
        if (pending.diff) {
          targetTimeline.latestReviewedApproval = {
            runId: pending.runId,
            callId: pending.callId,
            tool: pending.tool,
            reason: pending.reason,
            diff: pending.diff,
            diffHash: pending.diffHash,
            decision: 'stale',
          }
        }
        runtime.pendingApproval = undefined
        runtime.error =
          'This approval is no longer active. Review the latest run state.'
      } else {
        pending.status = 'requested'
        runtime.error = result.error.message
      }
    },
    /**
     * Applies a sequenced main-process agent event to the renderer stores.
     *
     * Keep the ingress rules centralized here: duplicate/gap detection,
     * session-close cleanup, and current-session filtering all happen before
     * domain state is updated. The switch below intentionally stays close to
     * the event contract so ordering-sensitive timeline updates are easy to
     * audit against `shared/agent-events`.
     */
    handleAgentEvent(event: AgentEvent) {
      const timeline = useAgentTimelineStore()
      const changes = useAgentChangesStore()
      const workbench = useAgentWorkbenchStore()

      if (event.type === 'workspace.writer.changed') {
        const runtime = this.ensureConversationRuntime(
          event.writerConversationId,
        )
        if (event.seq <= runtime.lastEventSeq) {
          this.addDiagnostic(
            event.writerConversationId,
            `Ignored stale workspace writer event ${event.seq}.`,
          )
          return
        }
        if (runtime.lastEventSeq > 0 && event.seq > runtime.lastEventSeq + 1) {
          this.addDiagnostic(
            event.writerConversationId,
            `Agent event gap: expected ${runtime.lastEventSeq + 1}, received ${event.seq}.`,
          )
        }
        runtime.lastEventSeq = event.seq
        this.registerSession(event.writerConversationId, event.writerSessionId)

        const ownerConversation = workbench.conversations.find(
          (item) => item.id === event.writerConversationId,
        )
        const workspaceKeys = new Set([
          event.workspace,
          ownerConversation?.projectPath,
        ])
        if (event.status === 'acquired') {
          const writer: WorkspaceWriterState = {
            workspace: event.workspace,
            writerConversationId: event.writerConversationId,
            writerSessionId: event.writerSessionId,
            writerRunId: event.writerRunId,
          }
          for (const workspace of workspaceKeys) {
            if (workspace) this.workspaceWriters[workspace] = writer
          }

          const active = workbench.activeConversation
          if (
            active &&
            workspaceKeys.has(active.projectPath) &&
            active.id !== event.writerConversationId
          ) {
            void this.ensureConversationReadonlyForWriter(active.id)
          }
        } else {
          for (const [workspace, writer] of Object.entries(
            this.workspaceWriters,
          )) {
            if (writer.writerRunId === event.writerRunId) {
              delete this.workspaceWriters[workspace]
            }
          }
          this.retryCarryoverInterjections()
        }
        return
      }

      const conversationId = this.conversationIdForSession(event.sessionId)
      if (!conversationId) {
        this.addDiagnostic(
          undefined,
          `Ignored event ${event.type} for unknown session ${event.sessionId}.`,
        )
        return
      }

      const runtime = this.ensureConversationRuntime(conversationId)
      if (event.seq <= runtime.lastEventSeq) {
        this.addDiagnostic(
          conversationId,
          `Ignored stale event ${event.seq} for ${event.type}.`,
        )
        return
      }
      if (runtime.lastEventSeq > 0 && event.seq > runtime.lastEventSeq + 1) {
        this.addDiagnostic(
          conversationId,
          `Agent event gap: expected ${runtime.lastEventSeq + 1}, received ${event.seq}.`,
        )
      }
      runtime.lastEventSeq = event.seq

      if (event.type === 'session.closed') {
        runtime.sessionId = undefined
        runtime.activeRunId = undefined
        runtime.startPending = false
        runtime.pendingApproval = undefined
        runtime.pendingCarryover = []
        runtime.runStatus = 'idle'
        delete this.conversationIdBySessionId[event.sessionId]
        return
      }

      runtime.sessionId = event.sessionId
      this.conversationIdBySessionId[event.sessionId] = conversationId

      if (conversationId !== workbench.activeConversationId) {
        const conversation = workbench.conversations.find(
          (item) => item.id === conversationId,
        )
        if (!conversation) return

        const backgroundTimeline = timelineAdapterFromConversation(
          conversation,
          runtime,
        )
        const persistBackgroundConversation = (touchUpdatedAt = true) => {
          if (touchUpdatedAt) conversation.updatedAt = new Date().toISOString()
          this.scheduleWorkbenchSave()
        }

        handleRuntimeAgentEvent(event, {
          runtime,
          timeline: backgroundTimeline,
          loadConversationChanges: () => {
            changes.workspaceFileRevision += 1
          },
          schedulePersist: persistBackgroundConversation,
          flushCarryoverInterjections: () =>
            this.flushCarryoverInterjections(conversationId),
        })
        if (
          event.type === 'run.status' &&
          ['completed', 'cancelled', 'failed'].includes(event.status)
        ) {
          this.retryCarryoverInterjections()
        }
        return
      }

      handleRuntimeAgentEvent(event, {
        runtime,
        timeline,
        loadConversationChanges: () => changes.loadConversationChanges(),
        schedulePersist: (touchUpdatedAt) =>
          this.schedulePersist(touchUpdatedAt),
        flushCarryoverInterjections: () => {
          return this.flushCarryoverInterjections(conversationId)
        },
      })
      runtime.timelineCounter = Math.max(
        runtime.timelineCounter,
        timeline.timelineCounter,
        runtime.pendingApproval?.order ?? 0,
      )
      if (
        event.type === 'run.status' &&
        ['completed', 'cancelled', 'failed'].includes(event.status)
      ) {
        this.retryCarryoverInterjections()
      }
    },
  },
})
