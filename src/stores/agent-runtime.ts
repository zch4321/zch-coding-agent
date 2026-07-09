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
  GoalState,
  PendingApproval,
  PlanState,
  ReviewedApproval,
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
import { cloneMessages, requestId } from './workbench-persistence'

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
  pendingApproval: PendingApproval | undefined
  pendingCarryover: PendingCarryoverInterjection[]
  error: string
}

interface TimelineAdapter extends RuntimeEventTimeline {
  timelineCounter: number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createConversationRuntime(
  conversationId: string,
): ConversationRuntimeState {
  return {
    conversationId,
    sessionId: undefined,
    activeRunId: undefined,
    runStatus: 'idle',
    pendingApproval: undefined,
    pendingCarryover: [],
    error: '',
  }
}

function runtimeBusy(runtime: ConversationRuntimeState | undefined): boolean {
  return Boolean(runtime?.activeRunId || runtime?.pendingApproval)
}

function conversationTimelineCounter(conversation: ConversationRecord): number {
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
  )
}

function timelineAdapterFromConversation(
  conversation: ConversationRecord,
): TimelineAdapter {
  const adapter: TimelineAdapter = {
    messages: cloneMessages(conversation.messages),
    tools: (conversation.tools ?? []).map((tool) => ({ ...tool })),
    usage: (conversation.usage ?? []).map((item) => ({ ...item })),
    goal: conversation.goal
      ? cloneJson<GoalState>(conversation.goal)
      : undefined,
    plan: conversation.plan
      ? cloneJson<PlanState>(conversation.plan)
      : undefined,
    latestReviewedApproval: conversation.latestReviewedApproval
      ? ({ ...conversation.latestReviewedApproval } satisfies ReviewedApproval)
      : undefined,
    timelineCounter: conversationTimelineCounter(conversation),
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
      adapter.timelineCounter += 1
      return adapter.timelineCounter
    },
  }
  return adapter
}

function writeTimelineAdapterToConversation(
  conversation: ConversationRecord,
  adapter: RuntimeEventTimeline,
): void {
  conversation.messages = cloneMessages(adapter.messages)
  conversation.tools = adapter.tools.map((tool) => ({ ...tool }))
  conversation.usage = adapter.usage.map((item) => ({ ...item }))
  conversation.goal = adapter.goal ? cloneJson(adapter.goal) : undefined
  conversation.plan = adapter.plan ? cloneJson(adapter.plan) : undefined
  conversation.latestReviewedApproval = adapter.latestReviewedApproval
    ? { ...adapter.latestReviewedApproval }
    : undefined
}

export const useAgentRuntimeStore = defineStore('agent-runtime', {
  state: () => ({
    error: '',
    conversationRuntimes: {} as Record<string, ConversationRuntimeState>,
    conversationIdBySessionId: {} as Record<string, string>,
    sessionIdsByConversation: {} as Record<string, SessionId>,
    sessionId: undefined as SessionId | undefined,
    activeRunId: undefined as RunId | undefined,
    runStatus: 'idle',
    mode: 'readonly' as PermissionMode,
    pendingApproval: undefined as PendingApproval | undefined,
    lastAgentSeqBySession: {} as Record<string, number>,
    agentEventGap: '',
    pendingCarryover: [] as PendingCarryoverInterjection[],
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
        (timeline.input.trim().length > 0 ||
          timeline.contextAttachments.length > 0) &&
        !state.pendingApproval,
      )
    },
    canInterject: (state) => {
      const shell = useAgentShellStore()
      const timeline = useAgentTimelineStore()
      // Interjections are allowed while a run is in progress, including while
      // it is paused on an approval. They queue and inject at the next
      // tool-batch boundary; they never cancel the run or the approval.
      const blockingApproval =
        state.pendingApproval?.status === 'submitting' ||
        (state.pendingApproval?.status === 'requested' &&
          state.runStatus !== 'awaiting_approval')
      return Boolean(
        shell.bridgeAvailable &&
        state.sessionId &&
        state.activeRunId &&
        state.runStatus !== 'cancelling' &&
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
      const sessionId = this.sessionIdsByConversation[conversationId]
      if (sessionId) {
        runtime.sessionId = sessionId
        this.conversationIdBySessionId[sessionId] = conversationId
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
    mirrorConversationRuntime(conversationId?: string) {
      const runtime = conversationId
        ? this.ensureConversationRuntime(conversationId)
        : undefined
      this.sessionId = runtime?.sessionId
      this.activeRunId = runtime?.activeRunId
      this.runStatus = runtime?.runStatus ?? 'idle'
      this.pendingApproval = runtime?.pendingApproval
      this.pendingCarryover = runtime?.pendingCarryover ?? []
      this.error = runtime?.error ?? this.error
    },
    currentConversationIsBusy(): boolean {
      const workbench = useAgentWorkbenchStore()
      const conversationId = workbench.activeConversationId
      if (!conversationId) return false
      return this.conversationIsBusy(conversationId)
    },
    conversationIsBusy(conversationId: string): boolean {
      const workbench = useAgentWorkbenchStore()
      const runtime = this.conversationRuntimes[conversationId]
      return (
        runtimeBusy(runtime) ||
        (conversationId === workbench.activeConversationId &&
          Boolean(this.activeRunId || this.pendingApproval))
      )
    },
    conversationIdForSession(sessionId: SessionId): string | undefined {
      const indexed = this.conversationIdBySessionId[sessionId]
      if (indexed) return indexed

      for (const [conversationId, candidate] of Object.entries(
        this.sessionIdsByConversation,
      )) {
        if (candidate === sessionId) {
          this.conversationIdBySessionId[sessionId] = conversationId
          return conversationId
        }
      }

      const workbench = useAgentWorkbenchStore()
      if (sessionId === this.sessionId && workbench.activeConversationId) {
        return workbench.activeConversationId
      }
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
        settings.activeProviderModel,
        this.mode,
      )
      const runtime = this.ensureConversationRuntime(conversation.id)
      runtime.sessionId = undefined
      runtime.activeRunId = undefined
      runtime.runStatus = 'idle'
      runtime.pendingApproval = undefined
      runtime.pendingCarryover = []
      runtime.error = ''
      this.mirrorConversationRuntime(conversation.id)
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
      workbench.activeConversationId = conversation.id
      this.restoreActiveConversation()
      workbench.persistWorkbench()
      return true
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
      this.mirrorConversationRuntime(forked.id)
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

      if (conversation) {
        workbench.workspacePath = conversation.projectPath
        this.mode = conversation.mode
        const runtime = this.ensureConversationRuntime(conversation.id)
        runtime.sessionId =
          runtime.sessionId ?? this.sessionIdsByConversation[conversation.id]
        if (runtime.sessionId) {
          this.conversationIdBySessionId[runtime.sessionId] = conversation.id
        }
        if (!runtime.activeRunId && !runtime.pendingApproval) {
          runtime.pendingCarryover = carryoverFromMessages(timeline.messages)
        }
      }
      this.mirrorConversationRuntime(conversation?.id)
      changes.reset()
      useAgentShellStore().error = ''
      useAgentSettingsStore().error = ''
      workbench.error = ''
      changes.error = ''
      this.error = ''
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
      conversation.mode = this.mode
      conversation.model = settings.activeProviderModel
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
      if (this.currentConversationIsBusy()) return false
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
      const runtime = this.currentConversationRuntime()
      if (runtime) this.mirrorConversationRuntime(runtime.conversationId)
      this.schedulePersist(false)
      return true
    },
    async updatePlanStatus(status: PlanStatus) {
      const timeline = useAgentTimelineStore()
      const bridge = window.agentApi
      if (!bridge || !this.sessionId || this.currentConversationIsBusy())
        return false

      const result = await bridge.updatePlanStatus({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        status,
      })

      if (result.ok && result.value.accepted) {
        timeline.plan = result.value.plan
          ? structuredClone(result.value.plan)
          : undefined
        this.schedulePersist(false)
        return true
      }

      this.error = result.ok
        ? 'The current plan state could not be changed.'
        : result.error.message
      return false
    },
    async approvePlan() {
      const timeline = useAgentTimelineStore()
      const settings = useAgentSettingsStore()
      const bridge = window.agentApi
      if (
        !bridge ||
        !this.sessionId ||
        !timeline.plan ||
        this.currentConversationIsBusy()
      ) {
        return false
      }

      if (!(await this.updatePlanStatus('active'))) return false

      const text =
        settings.assistantForm.language === 'zh-CN'
          ? '用户已批准当前计划。继续执行已激活的计划。'
          : 'The user approved the current plan. Continue executing the active plan.'
      const result = await bridge.startRun({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        message: text,
        clientRequestId: requestId(),
      })

      if (result.ok) {
        timeline.messages.push({
          id: requestId(),
          role: 'user',
          text,
          reasoning: '',
          order: timeline.nextTimelineOrder(),
        })
        const runtime = this.currentConversationRuntime()
        if (runtime) {
          runtime.activeRunId = result.value.runId
          runtime.runStatus = 'calling_llm'
          this.mirrorConversationRuntime(runtime.conversationId)
        } else {
          this.activeRunId = result.value.runId
        }
        this.schedulePersist()
        return true
      }

      this.error = result.error.message
      return false
    },
    async rejectPlan() {
      return this.updatePlanStatus('rejected')
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
        provider: settings.activeProviderId,
      })
      if (result.ok) {
        if (workbench.activeConversationId) {
          const runtime = this.ensureConversationRuntime(
            workbench.activeConversationId,
          )
          runtime.sessionId = result.value.sessionId
          this.sessionIdsByConversation[workbench.activeConversationId] =
            result.value.sessionId
          this.conversationIdBySessionId[result.value.sessionId] =
            workbench.activeConversationId
          this.mirrorConversationRuntime(workbench.activeConversationId)
        } else {
          this.sessionId = result.value.sessionId
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
        const runtime = this.conversationRuntimes[targetConversationId]
        if (runtime?.sessionId) {
          delete this.conversationIdBySessionId[runtime.sessionId]
        }
        if (runtime) {
          runtime.sessionId = undefined
          runtime.activeRunId = undefined
          runtime.pendingApproval = undefined
          runtime.pendingCarryover = []
          runtime.runStatus = 'idle'
          runtime.error = ''
        }
      }
      if (targetConversationId === workbench.activeConversationId) {
        this.mirrorConversationRuntime(targetConversationId)
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
      if (!bridge || !workbench.workspacePath) return false

      const result = await bridge.chooseWorkspaceContext({
        version: IPC_VERSION,
        workspace: workbench.workspacePath,
        kind,
      })

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      timeline.addContextAttachments(result.value.attachments)
      return result.value.attachments.length > 0
    },
    async sendMessage(options: SendMessageOptions | Event = {}) {
      const sendOptions = normalizeSendMessageOptions(options)
      const timeline = useAgentTimelineStore()
      const workbench = useAgentWorkbenchStore()
      const shell = useAgentShellStore()
      const settings = useAgentSettingsStore()
      const bridge = window.agentApi
      const explicitText = sendOptions.text?.trim()
      const draftText = timeline.input.trim()
      const text =
        explicitText ||
        draftText ||
        'Please inspect the attached workspace context.'
      const hasUserInput =
        Boolean(explicitText || draftText) ||
        timeline.contextAttachments.length > 0
      const canStartRun = Boolean(
        shell.bridgeAvailable &&
        settings.providerNoticeAccepted &&
        settings.credentialConfigured &&
        workbench.workspacePath &&
        workbench.activeConversationId &&
        !this.currentConversationIsBusy(),
      )
      if (!bridge || !text || !hasUserInput || !canStartRun) return false
      if (!this.sessionId && !(await this.createSession())) return false
      const sessionId = this.sessionId
      if (!sessionId) return false
      const includeContext = sendOptions.includeContext !== false
      const mentionAttachments = includeContext
        ? parseMentionAttachments(text)
        : []
      const contextAttachments = [
        ...(includeContext ? timeline.contextAttachments : []),
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
      if (result.ok) {
        if (sendOptions.clearInput !== false) {
          timeline.input = ''
          timeline.clearContextAttachments()
        }
        timeline.messages.push({
          id: requestId(),
          role: 'user',
          text,
          reasoning: '',
          attachments: contextAttachments.map((attachment) => ({
            ...attachment,
          })),
          order: timeline.nextTimelineOrder(),
        })
        const conversation = workbench.activeConversation
        if (conversation) {
          workbench.applyAutoTitle(conversation, text)
        }
        if (conversation?.transient) {
          delete conversation.transient
        }
        const runtime = this.currentConversationRuntime()
        if (runtime) {
          runtime.activeRunId = result.value.runId
          runtime.runStatus = 'calling_llm'
          this.mirrorConversationRuntime(runtime.conversationId)
        } else {
          this.activeRunId = result.value.runId
        }
        this.schedulePersist()
        return true
      }
      this.error = result.error.message
      return false
    },
    async sendInterjection() {
      const timeline = useAgentTimelineStore()
      const bridge = window.agentApi
      const text = timeline.input.trim()
      if (!bridge || !text || !this.canInterject) return
      const sessionId = this.sessionId
      const runId = this.activeRunId
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
        // The interjection.updated event may have arrived before the IPC
        // result resolved (the main process emits it synchronously). Avoid a
        // duplicate by only pushing when no message for this id exists yet.
        const alreadyPresent = timeline.messages.some(
          (item) => item.interjectionId === interjectionId,
        )
        if (!alreadyPresent) {
          timeline.messages.push({
            id: requestId(),
            role: 'interjection',
            runId,
            text,
            reasoning: '',
            interjectionId,
            interjectionStatus: 'queued',
            order: timeline.nextTimelineOrder(),
          })
        }
        timeline.input = ''
        // Interjections are text-only. Clear any context chips so they do not
        // leak into the next ordinary user turn.
        timeline.clearContextAttachments()
        this.schedulePersist()
      } else if (!result.ok) {
        this.error = result.error.message
      }
    },
    async flushCarryoverInterjections() {
      // Drain interjections that were carried over from a finished run's final
      // answer. Each becomes the next ordinary user turn. Only one is sent per
      // flush because sendMessage starts a new run; the rest drain when that
      // run terminates.
      if (this.activeRunId || this.pendingCarryover.length === 0) return
      const timeline = useAgentTimelineStore()
      const pending = this.pendingCarryover[0]
      if (!pending) return
      const sent = await this.sendMessage({
        text: pending.content,
        includeContext: false,
        clearInput: false,
      })
      if (!sent) return
      this.pendingCarryover.shift()
      const index = timeline.messages.findIndex(
        (item) =>
          item.role === 'interjection' &&
          item.interjectionId === pending.interjectionId,
      )
      if (index >= 0) {
        timeline.messages.splice(index, 1)
        this.schedulePersist()
      }
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
      const runtime = this.currentConversationRuntime()
      const pendingApproval = runtime?.pendingApproval ?? this.pendingApproval
      if (
        !bridge ||
        !this.sessionId ||
        !pendingApproval ||
        pendingApproval.status === 'submitting'
      ) {
        return
      }

      const pending = pendingApproval
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
        if (runtime) {
          runtime.pendingApproval = undefined
          this.mirrorConversationRuntime(runtime.conversationId)
        } else {
          this.pendingApproval = undefined
        }
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
        if (runtime) {
          runtime.pendingApproval = undefined
          this.mirrorConversationRuntime(runtime.conversationId)
        } else {
          this.pendingApproval = undefined
        }
        this.error =
          'This approval is no longer active. Review the latest run state.'
      } else {
        pending.status = 'requested'
        this.error = result.error.message
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

      const conversationId = this.conversationIdForSession(event.sessionId)
      if (event.type === 'session.closed') {
        const closedConversationId =
          conversationId ??
          Object.entries(this.sessionIdsByConversation).find(
            ([, sessionId]) => sessionId === event.sessionId,
          )?.[0]
        if (closedConversationId) {
          delete this.sessionIdsByConversation[closedConversationId]
          const runtime = this.conversationRuntimes[closedConversationId]
          if (runtime) {
            runtime.sessionId = undefined
            runtime.activeRunId = undefined
            runtime.pendingApproval = undefined
            runtime.pendingCarryover = []
            runtime.runStatus = 'idle'
            runtime.error = ''
          }
        }
        delete this.conversationIdBySessionId[event.sessionId]
        if (closedConversationId === workbench.activeConversationId) {
          this.mirrorConversationRuntime(closedConversationId)
        } else if (event.sessionId === this.sessionId) {
          this.sessionId = undefined
          this.activeRunId = undefined
          this.pendingApproval = undefined
          this.pendingCarryover = []
          this.runStatus = 'idle'
        }
        return
      }

      if (!conversationId) {
        if (event.sessionId !== this.sessionId) return
        handleRuntimeAgentEvent(event, {
          runtime: this,
          timeline,
          loadConversationChanges: () => changes.loadConversationChanges(),
          schedulePersist: (touchUpdatedAt) =>
            this.schedulePersist(touchUpdatedAt),
          flushCarryoverInterjections: () => this.flushCarryoverInterjections(),
        })
        return
      }

      const runtime = this.ensureConversationRuntime(conversationId)
      if (
        conversationId === workbench.activeConversationId &&
        event.sessionId === this.sessionId
      ) {
        runtime.activeRunId = runtime.activeRunId ?? this.activeRunId
        runtime.pendingApproval =
          runtime.pendingApproval ?? this.pendingApproval
        runtime.pendingCarryover =
          runtime.pendingCarryover.length > 0
            ? runtime.pendingCarryover
            : this.pendingCarryover
        if (runtime.runStatus === 'idle' && this.runStatus !== 'idle') {
          runtime.runStatus = this.runStatus as RunStatus | 'idle'
        }
      }
      runtime.sessionId = event.sessionId
      this.sessionIdsByConversation[conversationId] = event.sessionId
      this.conversationIdBySessionId[event.sessionId] = conversationId

      if (conversationId !== workbench.activeConversationId) {
        const conversation = workbench.conversations.find(
          (item) => item.id === conversationId,
        )
        if (!conversation) return

        const backgroundTimeline = timelineAdapterFromConversation(conversation)
        const persistBackgroundConversation = (touchUpdatedAt = true) => {
          writeTimelineAdapterToConversation(conversation, backgroundTimeline)
          if (touchUpdatedAt) conversation.updatedAt = new Date().toISOString()
          workbench.persistWorkbench()
        }

        handleRuntimeAgentEvent(event, {
          runtime,
          timeline: backgroundTimeline,
          loadConversationChanges: () => undefined,
          schedulePersist: persistBackgroundConversation,
          flushCarryoverInterjections: () => undefined,
        })
        persistBackgroundConversation()
        return
      }

      handleRuntimeAgentEvent(event, {
        runtime,
        timeline,
        loadConversationChanges: () => changes.loadConversationChanges(),
        schedulePersist: (touchUpdatedAt) =>
          this.schedulePersist(touchUpdatedAt),
        flushCarryoverInterjections: () => {
          this.mirrorConversationRuntime(conversationId)
          return this.flushCarryoverInterjections()
        },
      })
      this.mirrorConversationRuntime(conversationId)
    },
  },
})
