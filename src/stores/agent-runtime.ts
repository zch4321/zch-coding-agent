import { defineStore } from 'pinia'
import type { AgentEvent } from '../../shared/agent-events'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AssistantLanguage,
  ConfigSection,
  PermissionMode,
  PublicConfig,
} from '../../shared/config'
import type { RunId, SessionId } from '../../shared/ids'
import type { PendingApproval } from './agent-types'
import { useAgentChangesStore } from './agent-changes'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import { useAgentTimelineStore } from './agent-timeline'
import { useAgentWorkbenchStore } from './agent-workbench'
import { requestId } from './workbench-persistence'

let persistTimer: number | undefined

export const useAgentRuntimeStore = defineStore('agent-runtime', {
  state: () => ({
    error: '',
    sessionIdsByConversation: {} as Record<string, SessionId>,
    sessionId: undefined as SessionId | undefined,
    activeRunId: undefined as RunId | undefined,
    runStatus: 'idle',
    mode: 'readonly' as PermissionMode,
    pendingApproval: undefined as PendingApproval | undefined,
    lastAgentSeqBySession: {} as Record<string, number>,
    agentEventGap: '',
  }),
  getters: {
    approvalSubmitting: (state) =>
      state.pendingApproval?.status === 'submitting',
    canSend: (state) => {
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      const workbench = useAgentWorkbenchStore()
      const timeline = useAgentTimelineStore()
      return Boolean(
        shell.bridgeAvailable &&
        settings.providerNoticeAccepted &&
        settings.credentialConfigured &&
        workbench.workspacePath &&
        workbench.activeConversationId &&
        !state.activeRunId &&
        timeline.input.trim().length > 0 &&
        !state.pendingApproval,
      )
    },
  },
  actions: {
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
        this.error = result.error.message
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
        settings.providerForm.model,
        this.mode,
      )
      this.sessionId = undefined
      timeline.reset()
      this.pendingApproval = undefined
      changes.reset()
      workbench.persistWorkbench()
      return conversation
    },
    async newConversation() {
      const workbench = useAgentWorkbenchStore()
      if (!workbench.workspacePath) {
        const selected = await this.chooseWorkspace()
        if (!selected) return false
      }
      this.saveActiveConversation()
      this.createConversation()
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
      if (this.activeRunId || this.pendingApproval) return false

      this.saveActiveConversation()
      if (!(await workbench.activateWorkspace(conversation.projectPath))) {
        return false
      }
      workbench.activeConversationId = conversation.id
      this.restoreActiveConversation()
      workbench.persistWorkbench()
      return true
    },
    renameConversation(conversationId: string, title: string) {
      useAgentWorkbenchStore().renameConversation(conversationId, title)
    },
    async deleteConversation(conversationId: string) {
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation || this.activeRunId || this.pendingApproval) {
        return false
      }

      if (this.sessionIdsByConversation[conversationId]) {
        await this.closeRuntimeSession(conversationId)
      }
      workbench.removeConversationRecord(conversationId)

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
        this.activeRunId ||
        this.pendingApproval
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
        if (!result.ok) this.error = result.error.message
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
      this.sessionId = conversation
        ? this.sessionIdsByConversation[conversation.id]
        : undefined

      if (conversation) {
        workbench.workspacePath = conversation.projectPath
        this.mode = conversation.mode
      }
      this.pendingApproval = undefined
      changes.reset()
      useAgentShellStore().error = ''
      useAgentSettingsStore().error = ''
      workbench.error = ''
      changes.error = ''
      this.error = ''
    },
    saveActiveConversation(touchUpdatedAt = false) {
      const settings = useAgentSettingsStore()
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const conversation = workbench.activeConversation
      if (!conversation) return

      timeline.writeToConversation(conversation)
      conversation.mode = this.mode
      conversation.model = settings.providerForm.model
      if (touchUpdatedAt) conversation.updatedAt = new Date().toISOString()
    },
    schedulePersist(touchUpdatedAt = true) {
      const workbench = useAgentWorkbenchStore()
      this.saveActiveConversation(touchUpdatedAt)
      if (persistTimer !== undefined) window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(() => {
        workbench.persistWorkbench()
        persistTimer = undefined
      }, 250)
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
        this.error = result.error.message
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
      if (mode === this.mode) return true
      if (this.activeRunId || this.pendingApproval) return false
      const bridge = window.agentApi
      if (bridge && this.sessionId) {
        const result = await bridge.updateSessionMode({
          version: IPC_VERSION,
          sessionId: this.sessionId,
          mode,
        })
        if (!result.ok || !result.value.accepted) {
          this.error = result.ok
            ? 'The active session could not change permission mode.'
            : result.error.message
          return false
        }
      }
      this.mode = mode
      this.schedulePersist(false)
      return true
    },
    async createSession() {
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      if (!bridge || !workbench.workspacePath) return false

      this.error = ''
      const settings = useAgentSettingsStore()
      const result = await bridge.createSession({
        version: IPC_VERSION,
        conversationId: workbench.activeConversationId!,
        workspace: workbench.workspacePath,
        mode: this.mode,
        provider: settings.providerForm.providerId,
      })
      if (result.ok) {
        this.sessionId = result.value.sessionId
        if (workbench.activeConversationId) {
          this.sessionIdsByConversation[workbench.activeConversationId] =
            result.value.sessionId
        }
        return true
      }
      this.error = result.error.message
      return false
    },
    async closeRuntimeSession(conversationId?: string) {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const targetConversationId =
        conversationId ?? workbench.activeConversationId
      const sessionId = targetConversationId
        ? this.sessionIdsByConversation[targetConversationId]
        : undefined

      if (targetConversationId) {
        delete this.sessionIdsByConversation[targetConversationId]
      }
      if (targetConversationId === workbench.activeConversationId) {
        this.sessionId = undefined
        this.activeRunId = undefined
        this.pendingApproval = undefined
        this.runStatus = 'idle'
        timeline.tools = []
      }

      const bridge = window.agentApi
      if (bridge && sessionId) {
        await bridge.closeSession({ version: IPC_VERSION, sessionId })
      }
    },
    async sendMessage() {
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const text = timeline.input.trim()
      if (!bridge || !text || !this.canSend) return
      if (!this.sessionId && !(await this.createSession())) return
      const sessionId = this.sessionId
      if (!sessionId) return

      const result = await bridge.startRun({
        version: IPC_VERSION,
        sessionId,
        message: text,
        clientRequestId: requestId(),
      })
      if (result.ok) {
        timeline.input = ''
        timeline.messages.push({
          id: requestId(),
          role: 'user',
          text,
          reasoning: '',
          order: timeline.nextTimelineOrder(),
        })
        const conversation = workbench.activeConversation
        if (conversation?.title === 'New conversation') {
          conversation.title = text.replace(/\s+/g, ' ').slice(0, 56)
        }
        if (conversation?.transient) {
          delete conversation.transient
        }
        this.activeRunId = result.value.runId
        this.schedulePersist()
      } else this.error = result.error.message
    },
    async interruptRun() {
      const bridge = window.agentApi
      if (!bridge || !this.sessionId || !this.activeRunId) return
      await bridge.interruptRun({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        runId: this.activeRunId,
      })
    },
    async decideApproval(decision: 'allow' | 'deny', remember = false) {
      const timeline = useAgentTimelineStore()
      const bridge = window.agentApi
      if (
        !bridge ||
        !this.sessionId ||
        !this.pendingApproval ||
        this.pendingApproval.status === 'submitting'
      ) {
        return
      }

      const pending = this.pendingApproval
      pending.status = 'submitting'
      const rememberInput =
        decision === 'allow' && remember && pending.rememberable
          ? {
              workspaceScope: 'workspace' as const,
              expiresAt: new Date(
                Date.now() + 30 * 24 * 60 * 60_000,
              ).toISOString(),
            }
          : undefined
      const result = await bridge.decideApproval({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        runId: pending.runId,
        callId: pending.callId,
        decision,
        ...(rememberInput ? { remember: rememberInput } : {}),
      })

      if (result.ok && result.value.accepted) {
        if (pending.diff) {
          timeline.latestReviewedApproval = {
            runId: pending.runId,
            callId: pending.callId,
            tool: pending.tool,
            reason: pending.reason,
            diff: pending.diff,
            diffHash: pending.diffHash,
            decision: decision === 'allow' ? 'allowed' : 'denied',
          }
        }
        this.pendingApproval = undefined
      } else if (result.ok) {
        if (pending.diff) {
          timeline.latestReviewedApproval = {
            runId: pending.runId,
            callId: pending.callId,
            tool: pending.tool,
            reason: pending.reason,
            diff: pending.diff,
            diffHash: pending.diffHash,
            decision: 'stale',
          }
        }
        this.pendingApproval = undefined
        this.error =
          'This approval is no longer active. Review the latest run state.'
      } else {
        pending.status = 'requested'
        this.error = result.error.message
      }
    },
    handleAgentEvent(event: AgentEvent) {
      const timeline = useAgentTimelineStore()
      const changes = useAgentChangesStore()
      const previousSeq = this.lastAgentSeqBySession[event.sessionId] ?? 0
      if (event.seq <= previousSeq) return
      if (previousSeq > 0 && event.seq > previousSeq + 1) {
        this.agentEventGap =
          'Agent event gap detected: expected ' +
          (previousSeq + 1) +
          ', received ' +
          event.seq +
          '.'
      }
      this.lastAgentSeqBySession[event.sessionId] = event.seq

      if (event.type === 'session.closed') {
        for (const [conversationId, sessionId] of Object.entries(
          this.sessionIdsByConversation,
        )) {
          if (sessionId === event.sessionId) {
            delete this.sessionIdsByConversation[conversationId]
          }
        }
        if (event.sessionId === this.sessionId) {
          this.sessionId = undefined
          this.activeRunId = undefined
          this.pendingApproval = undefined
          this.runStatus = 'idle'
        }
        return
      }

      if (event.sessionId !== this.sessionId) return
      switch (event.type) {
        case 'run.status':
          this.runStatus = event.status
          this.activeRunId =
            event.status === 'completed' ||
            event.status === 'cancelled' ||
            event.status === 'failed'
              ? undefined
              : event.runId
          if (event.error) this.error = event.error.message
          if (!this.activeRunId) this.schedulePersist()
          break
        case 'assistant.text.delta':
          timeline.assistantMessage(event.runId).text += event.delta
          this.schedulePersist()
          break
        case 'assistant.reasoning.delta':
          timeline.assistantMessage(event.runId).reasoning += event.delta
          this.schedulePersist()
          break
        case 'tool.proposed':
          timeline.tools.unshift({
            callId: event.callId,
            runId: event.runId,
            tool: event.tool,
            args: event.args,
            reason: event.reason,
            status: 'proposed',
            order: timeline.nextTimelineOrder(),
          })
          break
        case 'tool.completed': {
          const tool = timeline.tools.find(
            (item) => item.callId === event.callId,
          )
          if (tool) {
            tool.status = 'completed'
            tool.result = event.result
            if (
              tool.tool === 'write_file' ||
              tool.tool === 'apply_patch' ||
              tool.tool === 'delete_file'
            ) {
              void changes.loadConversationChanges()
            }
          }
          break
        }
        case 'llm.usage':
          timeline.usage.push({
            runId: event.runId,
            callId: event.callId,
            usage: event.usage,
            order: timeline.nextTimelineOrder(),
          })
          this.schedulePersist()
          break
        case 'approval.requested':
          if (event.diff) timeline.latestReviewedApproval = undefined
          this.pendingApproval = {
            runId: event.runId,
            callId: event.callId,
            kind: event.kind,
            tool: event.tool,
            args: event.args,
            reason: event.reason,
            signals: event.policySignals,
            diff: event.diff,
            diffHash: event.diffHash,
            rememberable: event.rememberable,
            rememberArgConstraints: event.rememberArgConstraints,
            expiresAt: event.expiresAt,
            status: 'requested',
            order: timeline.nextTimelineOrder(),
          }
          break
      }
    },
  },
})
