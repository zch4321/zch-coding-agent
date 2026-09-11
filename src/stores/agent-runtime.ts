import { defineStore } from 'pinia'
import { toRaw, type ComputedRef } from 'vue'
import type { AgentEvent, RunStatus } from '../../shared/agent-events'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { PermissionMode } from '../../shared/config/security'
import type {
  ContextAttachmentChip,
  ContextAttachmentKind,
} from '../../shared/context'
import type { MessageId, ProjectId, RunId, SessionId } from '../../shared/ids'
import type { ConfigSection } from '../../shared/ipc/configuration'
import {
  evaluateModelRouteCompatibility,
  type ModelSelection,
} from '../../shared/model-route'
import type { PlanStatus } from '../../shared/orchestration'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { TodoState } from '../../shared/todo'
import { resolveManualContinuationTarget } from '../../shared/conversation-continuation'
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
  blankOverlay,
  originalUserRecord,
  pendingApprovalFromSnapshot,
  projectName,
  requestId,
  type CarryoverInterjection,
  type SendMessageOptions,
  type SessionOverlay,
} from './agent-runtime-helpers'
import { registerRuntimeSubscriptions } from './agent-runtime-subscriptions'
import { createConversationTimeline } from './conversation-timeline-view'
import { useApplicationSettingsStore } from './application-settings'
import { useAssistantSettingsStore } from './assistant-settings'
import { useIntegrationSettingsStore } from './integration-settings'
import { useModelRolesStore } from './model-roles'
import { useModelPoolSettingsStore } from './model-pool-settings'
import { useNetworkSettingsStore } from './network-settings'
import { useProviderSettingsStore } from './agent-settings'
import { useRuntimeSettingsStore } from './runtime-settings'
import { useSecuritySettingsStore } from './security-settings'
import { useAgentShellStore } from './agent-shell'
import { useNotificationStore } from './notifications'
import { useAgentExecutionStore } from './agent-executions'
import {
  sendComposerMessage,
  sendComposerInterjection,
  editComposerMessage,
  chooseComposerAttachment,
} from './agent-composer-actions'
import { composerDraftKey, useComposerDraftsStore } from './composer-drafts'
import {
  restoreComposerDraftView,
  selectedDraftTarget,
  trackComposerDraftView,
} from './composer-draft-view'

interface ApprovalDecisionInput {
  decision: 'allow' | 'deny'
  remember?: boolean
}

const timelineProjections = new WeakMap<
  object,
  ComputedRef<ConversationTurn[]>
>()

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
    mode: 'readonly' as PermissionMode,
    startPendingSessionId: undefined as SessionId | 'draft' | undefined,
    pendingDraftStarts: {} as Record<string, boolean>,
    carryoversBySessionId: {} as Record<string, CarryoverInterjection[]>,
    carryoverStartingBySessionId: {} as Record<string, boolean>,
    overlays: {} as Record<string, SessionOverlay>,
    approvalSubmitting: false,
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
      const replica = useAgentReplicaStore()
      const sessionId = replica.selectedSessionId
      const target = selectedDraftTarget(replica)
      return (
        Boolean(target && this.pendingDraftStarts[composerDraftKey(target)]) ||
        (this.startPendingSessionId !== undefined &&
          (this.startPendingSessionId === 'draft' ||
            this.startPendingSessionId === sessionId))
      )
    },
    pendingApproval(): PendingApproval | undefined {
      return this.activeOverlay?.approval
    },
    timelineTurns(): ConversationTurn[] {
      let projection = timelineProjections.get(this)
      if (!projection) {
        const replica = useAgentReplicaStore()
        projection = createConversationTimeline({
          records: () => replica.selectedMessages,
          overlay: () =>
            replica.selectedSessionId
              ? this.overlays[replica.selectedSessionId]
              : undefined,
        })
        timelineProjections.set(this, projection)
      }
      return projection.value
    },
    currentTodo(): TodoState | undefined {
      for (let index = this.timelineTurns.length - 1; index >= 0; index -= 1) {
        const todo = this.timelineTurns[index]?.todo
        if (todo) return todo
      }
      return undefined
    },
    usage(): UsageActivity[] {
      return this.activeOverlay?.usage ?? []
    },
    approvalUsageByCallId(): ReadonlyMap<string, UsageActivity> {
      const byId = new Map<string, UsageActivity>()
      for (const item of this.usage) {
        if (item.usage.scope === 'approval' && !byId.has(item.callId))
          byId.set(item.callId, item)
      }
      return byId
    },
    latestUsage(): UsageActivity['usage'] | undefined {
      return this.usage.at(-1)?.usage
    },
    latestReviewedApproval(): ReviewedApproval | undefined {
      return this.activeOverlay?.reviewedApproval
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
        this.composerReasoningValid &&
        this.composerCredentialConfigured &&
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
    manualContinuationTarget() {
      const replica = useAgentReplicaStore()
      const sessionId = replica.selectedSessionId
      if (
        !sessionId ||
        this.startPending ||
        this.activeRunId ||
        this.pendingApproval ||
        this.carryoverStartingBySessionId[sessionId] ||
        this.carryoversBySessionId[sessionId]?.length
      ) {
        return undefined
      }
      return resolveManualContinuationTarget(replica.selectedMessages)
    },
    composerModelSelection(state): ModelSelection {
      const replica = useAgentReplicaStore()
      const settings = useProviderSettingsStore()
      const sessionSelection = replica.selectedSession?.modelSelection
      if (sessionSelection) return sessionSelection

      const draftProvider = state.draftModelSelection
        ? settings.providers.find(
            (provider) => provider.id === state.draftModelSelection?.providerId,
          )
        : undefined
      if (state.draftModelSelection) {
        return draftProvider
          ? state.draftModelSelection
          : {
              providerId: '',
              model: '',
              reasoning: state.draftModelSelection.reasoning,
            }
      }

      const roles = useModelRolesStore()
      const provider = settings.providers.find(
        (candidate) => candidate.id === roles.defaultModelProvider,
      )
      const selection = {
        providerId: provider?.id ?? '',
        model: roles.defaultModel || provider?.model || '',
        reasoning: roles.defaultModelReasoning,
      }
      return evaluateModelRouteCompatibility(provider, selection).ok
        ? selection
        : { ...selection, providerId: '', model: '' }
    },
    composerProviderId(): string {
      return this.composerModelSelection.providerId
    },
    composerModel(): string {
      return this.composerModelSelection.model
    },
    composerCredentialConfigured(): boolean {
      const settings = useProviderSettingsStore()
      return Boolean(
        settings.providers.find(
          (provider) => provider.id === this.composerProviderId,
        )?.credentialConfigured,
      )
    },
    composerReasoning(): ModelSelection['reasoning'] {
      return this.composerModelSelection.reasoning
    },
    /**
     * True when the current selection's reasoning effort is supported by the
     * active model. The value is never auto-adjusted; an unsupported value
     * blocks sending until the user picks a supported one.
     */
    composerReasoningValid(): boolean {
      const settings = useProviderSettingsStore()
      const selection = this.composerModelSelection
      const provider = settings.providers.find(
        (candidate) => candidate.id === selection.providerId,
      )
      const compatibility = evaluateModelRouteCompatibility(provider, selection)
      return (
        compatibility.ok || compatibility.reason !== 'reasoning-unsupported'
      )
    },
    composerModelOptions(): Array<{ label: string; value: string }> {
      const settings = useProviderSettingsStore()
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
      overlay.streamActivity = undefined
      overlay.text = runtime.text
      overlay.reasoning = runtime.reasoning
      overlay.providerRetry = runtime.providerRetry
        ? structuredClone(toRaw(runtime.providerRetry))
        : undefined
      overlay.interjections = structuredClone(toRaw(runtime.interjections))
      overlay.todo = runtime.todo
        ? structuredClone(toRaw(runtime.todo))
        : undefined
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
      const security = useSecuritySettingsStore()
      const replica = useAgentReplicaStore()
      const executions = useAgentExecutionStore()
      const api = window.agentApi
      shell.bridgeAvailable = Boolean(api)
      if (!api) {
        shell.initialized = true
        return
      }
      registerRuntimeSubscriptions({
        api,
        shell,
        replica,
        executions,
        overlays: this.overlays,
        handleAgentEvent: (event) => this.handleAgentEvent(event),
      })
      const config = await api.getConfig({
        version: IPC_VERSION,
        section: 'all',
      })
      if (config.ok) this.applyConfig(config.value.config)
      else showOperationError(config.error)
      const bootstrapped = await replica.bootstrap(
        config.ok ? config.value.config.workspace.lastOpened : undefined,
      )
      if (bootstrapped) await restoreComposerDraftView(replica)
      shell.registerUnsubscriber(trackComposerDraftView(replica))
      this.mode =
        replica.selectedSession?.permissionMode ?? security.defaultMode
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
      useApplicationSettingsStore().applyConfig(config, sections)
      useAssistantSettingsStore().applyConfig(config, sections)
      useIntegrationSettingsStore().applyConfig(config, sections)
      useNetworkSettingsStore().applyConfig(config, sections)
      useProviderSettingsStore().applyConfig(config, sections)
      useRuntimeSettingsStore().applyConfig(config, sections)
      useSecuritySettingsStore().applyConfig(config, sections)
      useModelRolesStore().applyConfig(config, sections)
      useModelPoolSettingsStore().applyConfig(config, sections)
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
      this.mode = useSecuritySettingsStore().defaultMode
    },
    async selectConversation(sessionId: string) {
      const replica = useAgentReplicaStore()
      if (await replica.selectSession(sessionId as SessionId)) {
        this.mode =
          replica.sessions.find((session) => session.id === sessionId)
            ?.permissionMode ?? this.mode
        this.hydrateRuntime(replica.selectedRuntime)
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
    async exportConversationMarkdown(sessionId: string) {
      const session = useAgentReplicaStore().sessions.find(
        (candidate) => candidate.id === sessionId,
      )
      if (!session || !window.agentApi) return false
      const result = await window.agentApi.exportConversationMarkdown({
        version: IPC_VERSION,
        sessionId: session.id,
        confirmed: true,
      })
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      return true
    },
    async forkConversation(_title?: string, messageId?: string) {
      const replica = useAgentReplicaStore()
      const navigationRevision = replica.navigationRevision
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
      if (replica.navigationRevision !== navigationRevision) return
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
    /** Continues the interrupted turn without appending a user message. */
    async continueConversation() {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (!session || !this.manualContinuationTarget || !window.agentApi) {
        return false
      }
      this.startPendingSessionId = session.id
      let result: Awaited<ReturnType<typeof window.agentApi.continueRun>>
      try {
        result = await window.agentApi.continueRun({
          version: IPC_VERSION,
          sessionId: session.id,
          expectedRevision: session.revision,
          clientRequestId: requestId('continuation'),
        })
      } catch (error) {
        showOperationError(
          {
            code: 'RUN_CONTINUE_FAILED',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to continue the conversation.',
          },
          session.id,
        )
        return false
      } finally {
        if (this.startPendingSessionId === session.id) {
          this.startPendingSessionId = undefined
        }
      }
      if (!result.ok) {
        showOperationError(result.error, session.id)
        return false
      }
      this.hydrateRuntime(result.value.runtime)
      return true
    },
    /** Restores a user message into its originating composer after rewinding. */
    async editUserMessage(messageId: string): Promise<boolean> {
      return editComposerMessage(this, messageId)
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
        this.pendingDraftStarts[composerDraftKey({ projectId })] ||
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
          useSecuritySettingsStore().defaultMode
        this.hydrateRuntime(replica.selectedRuntime)
        this.draftModelSelection = undefined
        if (replica.selectedSessionId) {
          await executions.loadSession(replica.selectedSessionId)
        }
      }
      return true
    },
    async setMode(mode: PermissionMode) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      if (this.activeRunId || this.pendingApproval) {
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
    /** Switches the current Session or draft route to another provider's default model. */
    setComposerProvider(providerId: string) {
      const settings = useProviderSettingsStore()
      const provider = settings.providers.find(
        (candidate) => candidate.id === providerId,
      )
      if (!provider) return
      const replica = useAgentReplicaStore()
      const selection = {
        providerId: provider.id,
        model: provider.enabledModelIds.includes(provider.model)
          ? provider.model
          : '',
        reasoning: this.composerModelSelection.reasoning,
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
    async updateModelSelection(modelSelection: ModelSelection) {
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
    /** Starts a Run from the captured draft while preserving later edits and navigation. */
    async sendMessage(
      value: SendMessageOptions | Event = {},
    ): Promise<boolean> {
      return sendComposerMessage(this, value)
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
    /** Submits a text-only live interjection from the current draft. */
    async sendInterjection(): Promise<boolean> {
      return sendComposerInterjection(this)
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
      const language = useAssistantSettingsStore().assistantForm.language
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
    /** Opens the context picker for the originating composer. */
    async chooseContextAttachment(kind: ContextAttachmentKind): Promise<void> {
      return chooseComposerAttachment(kind)
    },
    addContextAttachments(attachments: ContextAttachmentChip[]) {
      const target = selectedDraftTarget(useAgentReplicaStore())
      if (target) useComposerDraftsStore().addAttachments(target, attachments)
    },
    removeContextAttachment(path: string, kind: ContextAttachmentKind) {
      const target = selectedDraftTarget(useAgentReplicaStore())
      if (!target) return
      const drafts = useComposerDraftsStore()
      const draft = drafts.get(target)
      drafts.set(
        target,
        draft.text,
        draft.attachments.filter(
          (attachment) => attachment.path !== path || attachment.kind !== kind,
        ),
      )
    },
    conversationIsBusy(sessionId: string): boolean {
      const overlay = this.overlays[sessionId]
      const session = useAgentReplicaStore().sessions.find(
        (item) => item.id === sessionId,
      )
      return Boolean(
        (session &&
          this.pendingDraftStarts[
            composerDraftKey({
              projectId: session.projectId,
              sessionId: session.id,
            })
          ]) ||
        overlay?.runId ||
        overlay?.approval ||
        this.startPendingSessionId === sessionId ||
        this.carryoverStartingBySessionId[sessionId] ||
        Boolean(this.carryoversBySessionId[sessionId]?.length),
      )
    },
    handleAgentEvent(event: AgentEvent) {
      handleRuntimeAgentEvent(this, event)
    },
  },
})
