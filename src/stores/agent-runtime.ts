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
} from '../../shared/context'
import type { MessageId, ProjectId, RunId, SessionId } from '../../shared/ids'
import type { ModelSelection } from '../../shared/model-route'
import type { PlanStatus } from '../../shared/orchestration'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { DurableRunStartResult } from '../../shared/domain-state-api'
import type {
  ConversationTurn,
  PendingApproval,
  ReviewedApproval,
  UsageActivity,
} from './agent-types'
import { useAgentReplicaStore } from './agent-replica'
import { handleRuntimeAgentEvent } from './agent-runtime-events'
import {
  attachmentRefs,
  blankOverlay,
  messageText,
  normalizeSendMessageOptions,
  originalUserRecord,
  parseMentionAttachments,
  pendingApprovalFromSnapshot,
  projectName,
  requestId,
  type CarryoverInterjection,
  type SendMessageOptions,
  type SessionOverlay,
} from './agent-runtime-helpers'
import { projectConversationTurns } from './conversation-timeline'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import { useNotificationStore } from './notifications'
import { useAgentExecutionStore } from './agent-executions'

interface ApprovalDecisionInput {
  decision: 'allow' | 'deny'
  remember?: boolean
}

function showOperationError(
  error: { code: string; message: string },
  sessionId?: SessionId,
): void {
  useNotificationStore().error({
    code: error.code,
    message: error.message,
    ...(sessionId ? { sessionId } : {}),
  })
}

function showValidationError(message: string, sessionId?: SessionId): void {
  useNotificationStore().error({
    code: 'VALIDATION_FAILED',
    message,
    ...(sessionId ? { sessionId } : {}),
  })
}

export const useAgentRuntimeStore = defineStore('agent-runtime', {
  state: () => ({
    input: '',
    contextAttachments: [] as ContextAttachmentChip[],
    mode: 'readonly' as PermissionMode,
    startPendingSessionId: undefined as SessionId | 'draft' | undefined,
    carryoversBySessionId: {} as Record<string, CarryoverInterjection[]>,
    carryoverStartingBySessionId: {} as Record<string, boolean>,
    overlays: {} as Record<string, SessionOverlay>,
    workspaceWriters: {} as Record<string, SessionId>,
    approvalSubmitting: false,
    workspaceFileRevision: 0,
    draftModelSelection: undefined as ModelSelection | undefined,
  }),
  getters: {
    activeOverlay(state): SessionOverlay | undefined {
      const sessionId = useAgentReplicaStore().selectedSessionId
      return sessionId ? state.overlays[sessionId] : undefined
    },
    sessionId(): SessionId | undefined {
      return useAgentReplicaStore().selectedSessionId
    },
    activeRunId(): RunId | undefined {
      return this.activeOverlay?.runId
    },
    runStatus(): RunStatus {
      return this.activeOverlay?.status ?? 'idle'
    },
    startPending(): boolean {
      const sessionId = useAgentReplicaStore().selectedSessionId
      return (
        this.startPendingSessionId !== undefined &&
        (this.startPendingSessionId === 'draft' ||
          this.startPendingSessionId === sessionId)
      )
    },
    pendingApproval(): PendingApproval | undefined {
      return this.activeOverlay?.approval
    },
    timelineTurns(): ConversationTurn[] {
      const replica = useAgentReplicaStore()
      const sessionId = replica.selectedSessionId
      return projectConversationTurns({
        records: replica.selectedMessages,
        overlay: sessionId ? this.overlays[sessionId] : undefined,
      })
    },
    usage(): UsageActivity[] {
      return this.activeOverlay?.usage ?? []
    },
    latestUsage(): UsageActivity['usage'] | undefined {
      return this.usage.at(-1)?.usage
    },
    latestReviewedApproval(): ReviewedApproval | undefined {
      return this.activeOverlay?.reviewedApproval
    },
    modeLockedByWriter(): boolean {
      const replica = useAgentReplicaStore()
      const project = replica.selectedProject
      const writer = project ? this.workspaceWriters[project.path] : undefined
      return Boolean(writer && writer !== replica.selectedSessionId)
    },
    modeLockTooltip(): string {
      const replica = useAgentReplicaStore()
      const project = replica.selectedProject
      const writer = project ? this.workspaceWriters[project.path] : undefined
      return writer && writer !== replica.selectedSessionId
        ? `Session ${writer} is modifying this workspace.`
        : ''
    },
    modeSyncError(): string {
      return ''
    },
    canSend(): boolean {
      const replica = useAgentReplicaStore()
      const sessionId = replica.selectedSessionId
      return Boolean(
        replica.selectedProjectId &&
        this.composerModelOptions.some(
          (option) => option.value === this.composerModel,
        ) &&
        !this.startPending &&
        !this.activeRunId &&
        !this.pendingApproval &&
        (!sessionId ||
          (!this.carryoverStartingBySessionId[sessionId] &&
            !this.carryoversBySessionId[sessionId]?.length)),
      )
    },
    canInterject(): boolean {
      return Boolean(this.activeRunId)
    },
    composerModelSelection(state): ModelSelection {
      const replica = useAgentReplicaStore()
      const settings = useAgentSettingsStore()
      const sessionSelection = replica.selectedSession?.modelSelection
      if (sessionSelection) return sessionSelection

      const draftProvider = state.draftModelSelection
        ? settings.providers.find(
            (provider) => provider.id === state.draftModelSelection?.providerId,
          )
        : undefined
      if (state.draftModelSelection && draftProvider) {
        return state.draftModelSelection
      }

      const provider =
        settings.providers.find(
          (candidate) => candidate.id === settings.activeProviderId,
        ) ?? settings.providers[0]
      return {
        providerId: provider?.id ?? settings.activeProviderId,
        model: provider?.model ?? settings.providerForm.model,
        reasoning: provider?.reasoning ?? settings.providerForm.reasoning,
      }
    },
    composerProviderId(): string {
      return this.composerModelSelection.providerId
    },
    composerModel(): string {
      return this.composerModelSelection.model
    },
    composerReasoning(): ModelSelection['reasoning'] {
      return this.composerModelSelection.reasoning
    },
    composerModelOptions(): Array<{ label: string; value: string }> {
      const settings = useAgentSettingsStore()
      const selection = this.composerModelSelection
      const provider = settings.providers.find(
        (candidate) => candidate.id === selection.providerId,
      )
      return (provider?.enabledModelIds ?? []).map((id) => ({
        label: id,
        value: id,
      }))
    },
  },
  actions: {
    ensureOverlay(sessionId: SessionId): SessionOverlay {
      return (this.overlays[sessionId] ??= blankOverlay())
    },
    hydrateRuntime(runtime: ActiveRunPublicSnapshot | undefined) {
      if (!runtime) return
      const overlay = this.ensureOverlay(runtime.sessionId)
      overlay.runId = runtime.runId
      overlay.terminalReloadRunId = undefined
      overlay.status = runtime.status
      overlay.text = runtime.text
      overlay.reasoning = runtime.reasoning
      overlay.interjections = structuredClone(runtime.interjections)
      overlay.tools = runtime.tools.map((tool, index) => ({
        callId: tool.callId,
        runId: runtime.runId,
        tool: tool.tool,
        args: tool.arguments ?? {},
        reason: '',
        status: tool.status === 'completed' ? 'completed' : 'proposed',
        result: tool.result,
        order: index + 1,
        live: true,
      }))
      overlay.order = overlay.tools.length
      overlay.approval = pendingApprovalFromSnapshot(runtime)
    },
    async initialize() {
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      const replica = useAgentReplicaStore()
      const executions = useAgentExecutionStore()
      shell.bridgeAvailable = Boolean(window.agentApi)
      if (!window.agentApi) {
        shell.initialized = true
        return
      }
      shell.disposeSubscriptions()
      shell.registerUnsubscriber(
        window.agentApi.onDomainStateEvent((delivery) => {
          if (delivery.kind === 'buffer_overflow') {
            void replica.bootstrap(replica.selectedProject?.path)
            return
          }
          const commit = delivery.event.commit
          void replica.reconcile(commit).then((outcome) => {
            if (outcome !== 'duplicate' && commit.topic === 'session.removed') {
              delete this.overlays[commit.change.sessionId]
              executions.removeSession(commit.change.sessionId)
            }
            if (outcome !== 'duplicate' && commit.topic === 'session.changed') {
              const overlay = this.overlays[commit.change.session.id]
              if (overlay) {
                overlay.goal = commit.change.session.goal
                  ? structuredClone(commit.change.session.goal)
                  : undefined
                overlay.plan = commit.change.session.plan
                  ? structuredClone(commit.change.session.plan)
                  : undefined
              }
            }
            if (
              outcome !== 'duplicate' &&
              commit.topic === 'session.changed' &&
              commit.change.messageChange.mode === 'upsert'
            ) {
              const overlay = this.overlays[commit.change.session.id]
              if (overlay) {
                if (
                  commit.change.messageChange.records.some(
                    (record) =>
                      record.kind === 'assistant_turn' &&
                      record.visibility === 'visible',
                  )
                ) {
                  overlay.text = ''
                  overlay.reasoning = ''
                }
                const durableInterjectionIds = new Set(
                  commit.change.messageChange.records.flatMap((record) =>
                    record.kind === 'interjection' &&
                    record.metadata?.interjectionId
                      ? [record.metadata.interjectionId]
                      : [],
                  ),
                )
                overlay.interjections = overlay.interjections.filter(
                  (interjection) =>
                    !durableInterjectionIds.has(interjection.id),
                )
              }
            }
          })
        }),
      )
      shell.registerUnsubscriber(
        window.agentApi.onAgentEvent((envelope) =>
          this.handleAgentEvent(envelope.event),
        ),
      )
      shell.registerUnsubscriber(
        window.agentApi.onAgentExecutionEvent((envelope) =>
          executions.handleEvent(envelope.event),
        ),
      )
      shell.registerUnsubscriber(
        window.agentApi.onBackendNotification((notification) => {
          useNotificationStore().enqueue(notification)
        }),
      )
      const config = await window.agentApi.getConfig({
        version: IPC_VERSION,
        section: 'all',
      })
      if (config.ok) settings.applyConfig(config.value.config)
      else showOperationError(config.error)
      await replica.bootstrap(
        config.ok ? config.value.config.workspace.lastOpened : undefined,
      )
      this.mode =
        replica.selectedSession?.permissionMode ?? settings.defaultMode
      this.hydrateRuntime(replica.selectedRuntime)
      if (replica.selectedSessionId) {
        await executions.loadSession(replica.selectedSessionId)
      }
      shell.initialized = true
    },
    dispose() {
      useAgentShellStore().disposeSubscriptions()
    },
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      useAgentSettingsStore().applyConfig(config, sections)
    },
    clearDiagnostics() {
      const overlay = this.activeOverlay
      if (overlay) overlay.diagnostics = []
    },
    async chooseWorkspace() {
      const api = window.agentApi
      if (!api) return
      const selected = await api.chooseWorkspace({ version: IPC_VERSION })
      if (!selected.ok) {
        showOperationError(selected.error)
        return
      }
      if (!selected.value.path) return
      const replica = useAgentReplicaStore()
      const existing = replica.projects.find(
        (project) => project.path === selected.value.path,
      )
      if (existing) {
        await replica.selectProject(existing.id)
        return
      }
      const result = await api.addProject({
        version: IPC_VERSION,
        path: selected.value.path,
        name: projectName(selected.value.path),
      })
      if (!result.ok) {
        showOperationError(result.error)
        return
      }
      await replica.reconcile(result.value.commit)
      const project = result.value.commit.change.projects.find(
        (candidate) => candidate.path === selected.value.path,
      )
      if (project) {
        replica.beginDraft(project.id)
        this.draftModelSelection = undefined
        this.input = ''
        this.contextAttachments = []
      }
    },
    async newConversation(workspacePath?: string) {
      const replica = useAgentReplicaStore()
      const project =
        replica.projects.find(
          (candidate) => candidate.path === workspacePath,
        ) ?? replica.selectedProject
      if (!project) {
        await this.chooseWorkspace()
        return
      }
      replica.beginDraft(project.id)
      this.draftModelSelection = undefined
      this.mode = useAgentSettingsStore().defaultMode
      this.input = ''
      this.contextAttachments = []
    },
    async selectConversation(sessionId: string) {
      const replica = useAgentReplicaStore()
      if (await replica.selectSession(sessionId as SessionId)) {
        this.mode =
          replica.sessions.find((session) => session.id === sessionId)
            ?.permissionMode ?? this.mode
        this.hydrateRuntime(replica.selectedRuntime)
        this.input = ''
        this.contextAttachments = []
        await useAgentExecutionStore().loadSession(sessionId as SessionId)
      }
    },
    async renameConversation(sessionId: string, title: string) {
      const replica = useAgentReplicaStore()
      const session = replica.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      const value = title.trim()
      if (!session || !value || !window.agentApi) return
      const result = await window.agentApi.updateSession({
        version: IPC_VERSION,
        sessionId: session.id,
        expectedRevision: session.revision,
        patch: { title: value },
      })
      if (result.ok) await replica.reconcile(result.value.commit)
      else showOperationError(result.error, session.id)
    },
    async deleteConversation(sessionId: string) {
      const replica = useAgentReplicaStore()
      const session = replica.sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (!session || !window.agentApi || this.conversationIsBusy(sessionId)) {
        return
      }
      const result = await window.agentApi.archiveSession({
        version: IPC_VERSION,
        sessionId: session.id,
        expectedRevision: session.revision,
      })
      if (result.ok) await replica.reconcile(result.value.commit)
      else showOperationError(result.error, session.id)
    },
    async forkConversation(_title?: string, messageId?: string) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (!session || !window.agentApi) return
      const forkId = requestId('session') as SessionId
      const result = await window.agentApi.forkSession({
        version: IPC_VERSION,
        sourceSessionId: session.id,
        expectedRevision: session.revision,
        sessionId: forkId,
        ...(messageId ? { throughMessageId: messageId as MessageId } : {}),
      })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return
      }
      await replica.reconcile(result.value.commit)
      await replica.selectSession(forkId)
      await useAgentExecutionStore().loadSession(forkId)
    },
    async rewindMessage(messageId: string) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      const record = replica.selectedMessages.find(
        (candidate) => candidate.id === messageId,
      )
      if (
        !session ||
        !record ||
        !window.agentApi ||
        (record.kind !== 'user_input' && record.kind !== 'assistant_turn')
      ) {
        return false
      }
      const result = await window.agentApi.rewindSession({
        version: IPC_VERSION,
        sessionId: session.id,
        expectedRevision: session.revision,
        messageId: record.id,
        boundary:
          record.kind === 'user_input' ? 'before_turn' : 'before_message',
      })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      await replica.reconcile(result.value.commit)
      delete this.overlays[session.id]
      return true
    },
    revertConversationAfterMessage(messageId: string) {
      return this.rewindMessage(messageId)
    },
    async retryUserMessage(messageId: string) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      const record = replica.selectedMessages.find(
        (candidate) => candidate.id === messageId,
      )
      if (!session || !originalUserRecord(record) || !window.agentApi) {
        showValidationError(
          'Only an original visible user message can be retried.',
          session?.id,
        )
        return false
      }
      if (
        this.startPending ||
        this.activeRunId ||
        this.pendingApproval ||
        this.carryoverStartingBySessionId[session.id] ||
        this.carryoversBySessionId[session.id]?.length
      ) {
        return false
      }
      this.startPendingSessionId = session.id
      const result = await window.agentApi
        .retryRun({
          version: IPC_VERSION,
          sessionId: session.id,
          expectedRevision: session.revision,
          userMessageId: record.id,
          clientRequestId: requestId('request'),
        })
        .finally(() => {
          if (this.startPendingSessionId === session.id) {
            this.startPendingSessionId = undefined
          }
        })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      await replica.reconcile(result.value.commit)
      this.hydrateRuntime(result.value.runtime)
      return true
    },
    async editUserMessage(messageId: string) {
      const replica = useAgentReplicaStore()
      const record = replica.selectedMessages.find(
        (candidate) => candidate.id === messageId,
      )
      if (!originalUserRecord(record)) {
        showValidationError(
          'Only an original visible user message can be edited.',
          replica.selectedSessionId,
        )
        return false
      }
      const text = messageText(record)
      const attachments = record.metadata.attachments ?? []
      if (!(await this.rewindMessage(messageId))) return false
      this.input = text
      this.contextAttachments = structuredClone(attachments)
      return true
    },
    /** Removes an idle Project and all of its application-owned history. */
    async removeProject(projectId: ProjectId): Promise<boolean> {
      const replica = useAgentReplicaStore()
      const removingSelectedProject = replica.selectedProjectId === projectId
      const project = replica.projects.find(
        (candidate) => candidate.id === projectId,
      )
      if (!project || !window.agentApi) return false
      const projectSessionIds = replica.sessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.id)
      if (
        replica.sessions.some(
          (session) =>
            session.projectId === project.id &&
            this.conversationIsBusy(session.id),
        )
      ) {
        return false
      }
      const result = await window.agentApi.removeProject({
        version: IPC_VERSION,
        projectId: project.id,
        expectedRevision: project.revision,
      })
      if (!result.ok) {
        showOperationError(result.error)
        return false
      }
      await replica.reconcile(result.value.commit)
      const executions = useAgentExecutionStore()
      for (const sessionId of projectSessionIds) {
        delete this.overlays[sessionId]
        delete this.carryoversBySessionId[sessionId]
        delete this.carryoverStartingBySessionId[sessionId]
        executions.removeSession(sessionId)
      }
      if (removingSelectedProject) {
        this.mode =
          replica.selectedSession?.permissionMode ??
          useAgentSettingsStore().defaultMode
        this.hydrateRuntime(replica.selectedRuntime)
        this.draftModelSelection = undefined
        this.input = ''
        this.contextAttachments = []
        if (replica.selectedSessionId) {
          await executions.loadSession(replica.selectedSessionId)
        }
      }
      return true
    },
    async setMode(mode: PermissionMode) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (this.modeLockedByWriter || this.activeRunId || this.pendingApproval) {
        return false
      }
      if (!session || !window.agentApi) {
        this.mode = mode
        return true
      }
      const result = await window.agentApi.updateSession({
        version: IPC_VERSION,
        sessionId: session.id,
        expectedRevision: session.revision,
        patch: { permissionMode: mode },
      })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      await replica.reconcile(result.value.commit)
      this.mode = mode
      return true
    },
    async setActiveProvider(providerId: string) {
      const settings = useAgentSettingsStore()
      if (!(await settings.setActiveProvider(providerId))) return false
      const provider = settings.providers.find((item) => item.id === providerId)
      if (provider?.model) {
        const selection = {
          providerId,
          model: provider.model,
          reasoning: provider.reasoning,
        }
        if (useAgentReplicaStore().selectedSession) {
          await this.updateModelSelection(selection)
        } else {
          this.draftModelSelection = selection
        }
      }
      return true
    },
    /** Updates the current Session or draft model while preserving its reasoning effort. */
    setProviderModel(model: string) {
      const replica = useAgentReplicaStore()
      const current = this.composerModelSelection
      const selection = {
        ...current,
        model,
      }
      if (replica.selectedSession) {
        void this.updateModelSelection(selection)
      } else {
        this.draftModelSelection = selection
      }
    },
    /** Updates the reasoning effort for the current Session or draft route. */
    setProviderReasoning(reasoning: ModelSelection['reasoning']) {
      const replica = useAgentReplicaStore()
      const selection = {
        ...this.composerModelSelection,
        reasoning,
      }
      if (replica.selectedSession) {
        void this.updateModelSelection(selection)
      } else {
        this.draftModelSelection = selection
      }
    },
    async updateModelSelection(modelSelection: {
      providerId: string
      model: string
      reasoning: PublicConfig['providers'][number]['reasoning']
    }) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (!session || !window.agentApi || this.activeRunId) return
      const result = await window.agentApi.updateSession({
        version: IPC_VERSION,
        sessionId: session.id,
        expectedRevision: session.revision,
        patch: { modelSelection },
      })
      if (result.ok) await replica.reconcile(result.value.commit)
      else showOperationError(result.error, session.id)
    },
    async sendMessage(value: SendMessageOptions | Event = {}) {
      const options = normalizeSendMessageOptions(value)
      const replica = useAgentReplicaStore()
      const project = replica.selectedProject
      const session = replica.selectedSession
      const text = (options.text ?? this.input).trim()
      if (
        !window.agentApi ||
        !project ||
        !text ||
        this.startPending ||
        this.activeRunId ||
        this.pendingApproval ||
        (session &&
          (this.carryoverStartingBySessionId[session.id] ||
            this.carryoversBySessionId[session.id]?.length))
      ) {
        return false
      }
      const attachments =
        options.includeContext === false
          ? []
          : [
              ...this.contextAttachments,
              ...parseMentionAttachments(text),
            ].filter(
              (attachment, index, all) =>
                all.findIndex(
                  (candidate) =>
                    candidate.kind === attachment.kind &&
                    candidate.path === attachment.path,
                ) === index,
            )
      const sessionId = session?.id ?? (requestId('session') as SessionId)
      this.startPendingSessionId = session?.id ?? 'draft'
      const pendingMarker = this.startPendingSessionId
      const result = await window.agentApi
        .startRun(
          session
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
                modelSelection: structuredClone(this.composerModelSelection),
                permissionMode: this.modeLockedByWriter
                  ? 'readonly'
                  : this.mode,
                message: text,
                context: { attachments: attachmentRefs(attachments) },
                clientRequestId: requestId('request'),
              },
        )
        .finally(() => {
          if (this.startPendingSessionId === pendingMarker) {
            this.startPendingSessionId = undefined
          }
        })
      if (!result.ok) {
        showOperationError(result.error, sessionId)
        return false
      }
      const runResult = result.value as DurableRunStartResult
      await this.applyRunStartResult(sessionId, runResult)
      replica.selectedProjectId = project.id
      replica.selectedSessionId = sessionId
      if (options.clearInput !== false) {
        this.input = ''
        this.contextAttachments = []
      }
      return true
    },
    /** Applies either a fresh or deduplicated durable run-start result. */
    async applyRunStartResult(
      sessionId: SessionId,
      runResult: DurableRunStartResult,
    ): Promise<void> {
      const replica = useAgentReplicaStore()
      if (runResult.outcome === 'started') {
        await replica.reconcile(runResult.commit)
        this.hydrateRuntime(runResult.runtime)
        return
      }
      replica.sessions = [
        ...replica.sessions.filter(
          (candidate) => candidate.id !== runResult.session.id,
        ),
        structuredClone(runResult.session),
      ]
      replica.messagesBySessionId[sessionId] = [
        ...(replica.messagesBySessionId[sessionId] ?? []).filter(
          (record) => record.id !== runResult.userMessage.id,
        ),
        structuredClone(runResult.userMessage),
      ].sort((left, right) => left.seq - right.seq)
      this.hydrateRuntime(runResult.runtime)
    },
    /** Starts the next carried-over interjection for one Session in FIFO order. */
    async flushCarryovers(sessionId: SessionId): Promise<boolean> {
      const api = window.agentApi
      const queue = this.carryoversBySessionId[sessionId]
      const overlay = this.overlays[sessionId]
      const session = useAgentReplicaStore().sessions.find(
        (candidate) =>
          candidate.id === sessionId && candidate.lifecycle === 'active',
      )
      if (
        !queue?.length ||
        overlay?.runId ||
        this.carryoverStartingBySessionId[sessionId]
      ) {
        return false
      }
      if (!api || !session) {
        const discardedIds = new Set(queue.map((item) => item.id))
        delete this.carryoversBySessionId[sessionId]
        delete this.carryoverStartingBySessionId[sessionId]
        if (overlay) {
          overlay.interjections = overlay.interjections.filter(
            (interjection) => !discardedIds.has(interjection.id),
          )
        }
        useNotificationStore().warning({
          code: 'CARRYOVER_DISCARDED',
          message:
            'Carried-over messages could not be started and were discarded.',
          sessionId,
        })
        return false
      }
      const carryover = queue[0]!
      const removeCarryover = () => {
        this.carryoversBySessionId[sessionId] = (
          this.carryoversBySessionId[sessionId] ?? []
        ).filter((candidate) => candidate.id !== carryover.id)
        const currentOverlay = this.overlays[sessionId]
        if (currentOverlay) {
          currentOverlay.interjections = currentOverlay.interjections.filter(
            (interjection) => interjection.id !== carryover.id,
          )
        }
      }
      this.carryoverStartingBySessionId[sessionId] = true
      try {
        let result
        try {
          result = await api.startRun({
            version: IPC_VERSION,
            kind: 'existing_session',
            sessionId,
            message: carryover.content,
            context: { attachments: [] },
            clientRequestId: `carryover:${carryover.id}`,
          })
        } catch {
          removeCarryover()
          useNotificationStore().warning({
            code: 'CARRYOVER_DISCARDED',
            message:
              'The carried-over message could not be started and was discarded.',
            sessionId,
          })
          return false
        }
        if (!result.ok) {
          removeCarryover()
          useNotificationStore().warning({
            code: 'CARRYOVER_DISCARDED',
            message: result.error.message,
            sessionId,
          })
          return false
        }
        removeCarryover()
        try {
          await this.applyRunStartResult(sessionId, result.value)
        } catch {
          this.hydrateRuntime(result.value.runtime)
          showValidationError(
            'The carried-over request started, but the local view could not be refreshed.',
            sessionId,
          )
          void useAgentReplicaStore().loadSession(sessionId)
          return false
        }
        return true
      } finally {
        delete this.carryoverStartingBySessionId[sessionId]
        if (
          this.carryoversBySessionId[sessionId]?.length &&
          !this.overlays[sessionId]?.runId
        ) {
          queueMicrotask(() => void this.flushCarryovers(sessionId))
        }
      }
    },
    async sendInterjection() {
      const overlay = this.activeOverlay
      const sessionId = useAgentReplicaStore().selectedSessionId
      const message = this.input.trim()
      if (!window.agentApi || !sessionId || !overlay?.runId || !message) {
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
      this.input = ''
      return true
    },
    async interruptRun() {
      const overlay = this.activeOverlay
      const sessionId = useAgentReplicaStore().selectedSessionId
      if (!window.agentApi || !sessionId || !overlay?.runId) return false
      const result = await window.agentApi.interruptRun({
        version: IPC_VERSION,
        sessionId,
        runId: overlay.runId,
      })
      if (!result.ok) showOperationError(result.error, sessionId)
      return result.ok && result.value.accepted
    },
    async decideApproval(input: ApprovalDecisionInput) {
      const overlay = this.activeOverlay
      const sessionId = useAgentReplicaStore().selectedSessionId
      const approval = overlay?.approval
      if (!window.agentApi || !sessionId || !overlay?.runId || !approval) {
        return false
      }
      this.approvalSubmitting = true
      approval.status = 'submitting'
      const result = await window.agentApi.decideApproval({
        version: IPC_VERSION,
        sessionId,
        runId: overlay.runId,
        callId: approval.callId,
        decision: input.decision,
        ...(input.remember
          ? { remember: { workspaceScope: 'workspace' as const } }
          : {}),
      })
      this.approvalSubmitting = false
      if (!result.ok) {
        approval.status = 'requested'
        showOperationError(result.error, sessionId)
        return false
      }
      overlay.reviewedApproval = {
        runId: overlay.runId,
        callId: approval.callId,
        tool: approval.tool,
        reason: approval.reason,
        diff: approval.diff ?? '',
        diffHash: approval.diffHash,
        decision: input.decision === 'allow' ? 'allowed' : 'denied',
      }
      overlay.approval = undefined
      return true
    },
    async updatePlanStatus(status: PlanStatus) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (!window.agentApi || !session) return false
      const result = await window.agentApi.updatePlanStatus({
        version: IPC_VERSION,
        sessionId: session.id,
        status,
      })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      await replica.reconcile(result.value.commit)
      return true
    },
    async approvePlan() {
      if (!(await this.updatePlanStatus('active'))) return false
      const language = useAgentSettingsStore().assistantForm.language
      return this.sendMessage({
        text:
          language === 'zh-CN'
            ? '用户已批准当前计划。继续执行已激活的计划。'
            : 'The user approved the current plan. Continue executing the active plan.',
        includeContext: false,
        clearInput: false,
      })
    },
    async rejectPlan() {
      return this.updatePlanStatus('rejected')
    },
    async chooseContextAttachment(kind: ContextAttachmentKind) {
      const projectId = useAgentReplicaStore().selectedProjectId
      if (!window.agentApi || !projectId) return
      const result = await window.agentApi.chooseWorkspaceContext({
        version: IPC_VERSION,
        projectId,
        kind,
      })
      if (!result.ok) {
        showOperationError(result.error)
        return
      }
      this.addContextAttachments(result.value.attachments)
    },
    addContextAttachments(attachments: ContextAttachmentChip[]) {
      const existing = new Set(
        this.contextAttachments.map((item) => `${item.kind}:${item.path}`),
      )
      for (const attachment of attachments) {
        const key = `${attachment.kind}:${attachment.path}`
        if (existing.has(key)) continue
        existing.add(key)
        this.contextAttachments.push(structuredClone(attachment))
      }
    },
    removeContextAttachment(path: string, kind: ContextAttachmentKind) {
      this.contextAttachments = this.contextAttachments.filter(
        (attachment) => attachment.path !== path || attachment.kind !== kind,
      )
    },
    conversationIsBusy(sessionId: string): boolean {
      const overlay = this.overlays[sessionId]
      return Boolean(
        overlay?.runId ||
        overlay?.approval ||
        this.startPendingSessionId === sessionId ||
        this.carryoverStartingBySessionId[sessionId] ||
        Boolean(this.carryoversBySessionId[sessionId]?.length),
      )
    },
    conversationStatus(sessionId: string): string | undefined {
      const overlay = this.overlays[sessionId]
      if (!overlay) return undefined
      if (overlay.approval) return 'awaitingApproval'
      if (overlay.runId) return overlay.status
      return undefined
    },
    saveAssistantSettings(language?: AssistantLanguage) {
      return useAgentSettingsStore().saveAssistantSettings(language)
    },
    handleAgentEvent(event: AgentEvent) {
      handleRuntimeAgentEvent(this, event)
    },
  },
})
