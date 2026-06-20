import { defineStore } from 'pinia'
import type { AgentEvent } from '../../shared/agent-events'
import type { AgentApi } from '../../shared/agent-api'
import type { PermissionMode, PublicConfig } from '../../shared/config'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { IPC_VERSION } from '../../shared/channels'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
  YOLO_NOTICE_VERSION,
} from '../../shared/notices'

type Role = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: Role
  runId?: RunId
  text: string
  reasoning: string
}

export interface ToolActivity {
  callId: CallId
  runId: RunId
  tool: string
  args: unknown
  reason: string
  status: 'proposed' | 'completed'
  result?: unknown
}

export interface PendingApproval {
  runId: RunId
  callId: CallId
  kind: 'tool' | 'context'
  tool: string
  args: unknown
  reason: string
  signals: Array<{ code: string; severity: string; detail: string }>
  diff?: string
  diffHash?: string
  rememberable: boolean
  expiresAt: string
}

export interface ProjectRecord {
  path: string
  name: string
  addedAt: string
}

export interface ConversationRecord {
  id: string
  projectPath: string
  title: string
  model: string
  mode: PermissionMode
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

interface PersistedWorkbench {
  projects: ProjectRecord[]
  conversations: ConversationRecord[]
  activeConversationId?: string
}

interface UiRememberedRule {
  id: string
  effect: 'allow' | 'review'
  toolId: string
  workspaceScope: string
  argConstraints: string
  expiresAt?: string
  createdFromCallId: string
}

interface UiModelProfile {
  id: string
  ownedBy?: string
  availability: 'provider' | 'custom'
  capabilitySource: 'override' | 'builtin' | 'default'
  contextWindowTokens: number
  maxOutputTokens?: number
}

const HISTORY_KEY = 'my-coding-agent.workbench.v1'
let persistTimer: number | undefined

function api(): AgentApi | undefined {
  return window.agentApi
}

function requestId(): string {
  return `ui:${
    'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}:${Math.random().toString(16).slice(2)}`
  }`
}

function nowNotice(version: string) {
  return { version, acceptedAt: new Date().toISOString() }
}

function projectName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? workspacePath
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message }))
}

function toUiRememberedRules(config: PublicConfig): UiRememberedRule[] {
  return config.permission.rememberedRules.map((rule) => ({
    id: rule.id,
    effect: rule.effect,
    toolId: rule.toolId,
    workspaceScope: rule.workspaceScope,
    argConstraints: JSON.stringify(rule.argConstraints),
    expiresAt: rule.expiresAt,
    createdFromCallId: rule.createdFromCallId,
  }))
}

function loadWorkbench(): PersistedWorkbench {
  try {
    const value = window.localStorage.getItem(HISTORY_KEY)

    if (!value) {
      return { projects: [], conversations: [] }
    }

    const parsed = JSON.parse(value) as Partial<PersistedWorkbench>
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations
        : [],
      activeConversationId:
        typeof parsed.activeConversationId === 'string'
          ? parsed.activeConversationId
          : undefined,
    }
  } catch {
    return { projects: [], conversations: [] }
  }
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    initialized: false,
    bridgeAvailable: false,
    providerNoticeVersion: '',
    traceNoticeVersion: '',
    yoloNoticeVersion: '',
    credentialConfiguredValue: false,
    builtinPolicies: true,
    rememberedRules: [] as UiRememberedRule[],
    workspacePath: '',
    projects: [] as ProjectRecord[],
    conversations: [] as ConversationRecord[],
    activeConversationId: undefined as string | undefined,
    sessionIdsByConversation: {} as Record<string, SessionId>,
    sessionId: undefined as SessionId | undefined,
    activeRunId: undefined as RunId | undefined,
    runStatus: 'idle',
    mode: 'readonly' as PermissionMode,
    input: '',
    messages: [] as ChatMessage[],
    tools: [] as ToolActivity[],
    pendingApproval: undefined as PendingApproval | undefined,
    error: '',
    modelProfiles: [] as UiModelProfile[],
    modelCatalogFetchedAt: undefined as string | undefined,
    modelCatalogStale: true,
    modelCatalogLoading: false,
    modelOverrides:
      {} as PublicConfig['providers']['deepseek']['modelOverrides'],
    limitsConfig: undefined as PublicConfig['limits'] | undefined,
    providerForm: {
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      reasoning: 'auto' as 'auto' | 'off',
      apiKey: '',
      approverModel: 'deepseek-chat',
      contextWindowTokens: null as number | null,
      maxOutputTokens: null as number | null,
      tokenEstimationMode: 'conservative' as 'conservative' | 'custom-bytes',
      bytesPerToken: 3,
    },
    permissionForm: {
      sensitiveMode: 'confirm' as 'off' | 'warn' | 'confirm',
      pathGlobs: '',
      contentPatterns: '',
    },
    loggingForm: {
      enabled: false,
      retentionDays: 14,
      maxTotalMegabytes: 100,
    },
    unsubscribers: [] as Array<() => void>,
  }),
  getters: {
    activeConversation: (state): ConversationRecord | undefined =>
      state.conversations.find(
        (conversation) => conversation.id === state.activeConversationId,
      ),
    providerNoticeAccepted: (state) =>
      state.providerNoticeVersion === PROVIDER_NOTICE_VERSION,
    traceNoticeAccepted: (state) =>
      state.traceNoticeVersion === TRACE_NOTICE_VERSION,
    yoloNoticeAccepted: (state) =>
      state.yoloNoticeVersion === YOLO_NOTICE_VERSION,
    credentialConfigured: (state) => state.credentialConfiguredValue,
    canSend: (state) =>
      Boolean(
        state.bridgeAvailable &&
        state.providerNoticeVersion === PROVIDER_NOTICE_VERSION &&
        state.credentialConfiguredValue &&
        state.workspacePath &&
        state.activeConversationId &&
        !state.activeRunId &&
        state.input.trim().length > 0 &&
        !state.pendingApproval,
      ),
    modelOptions: (state) =>
      state.modelProfiles.map((model) => ({
        label: model.id,
        value: model.id,
      })),
    activeModelProfile: (state) =>
      state.modelProfiles.find(
        (model) => model.id === state.providerForm.model,
      ),
  },
  actions: {
    async initialize() {
      if (this.initialized) {
        return
      }

      const history = loadWorkbench()
      this.projects = history.projects
      this.conversations = history.conversations
      this.activeConversationId = history.activeConversationId

      const bridge = api()
      this.bridgeAvailable = Boolean(bridge)

      if (!bridge) {
        this.restoreActiveConversation()
        this.initialized = true
        return
      }

      const result = await bridge.getConfig({
        version: IPC_VERSION,
        section: 'all',
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
        this.workspacePath = result.value.config.workspace.lastOpened ?? ''

        if (this.workspacePath) {
          this.registerProject(this.workspacePath)
          const active = this.conversations.find(
            (conversation) =>
              conversation.id === this.activeConversationId &&
              conversation.projectPath === this.workspacePath,
          )
          const latest = this.conversations
            .filter(
              (conversation) => conversation.projectPath === this.workspacePath,
            )
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )[0]

          if (active || latest) {
            this.activeConversationId = (active ?? latest)?.id
          } else {
            this.createConversation(this.workspacePath)
          }
        }
      } else {
        this.error = result.error.message
      }

      await this.loadProviderModels(false)

      this.restoreActiveConversation()
      this.unsubscribers.push(
        bridge.onAgentEvent((envelope) =>
          this.handleAgentEvent(envelope.event),
        ),
      )
      this.initialized = true
      this.persistWorkbench()
    },
    dispose() {
      if (persistTimer !== undefined) {
        window.clearTimeout(persistTimer)
        persistTimer = undefined
      }
      this.saveActiveConversation()
      this.persistWorkbench()

      for (const unsubscribe of this.unsubscribers.splice(0)) {
        unsubscribe()
      }
    },
    applyConfig(config: PublicConfig) {
      this.providerNoticeVersion =
        config.privacy.providerNoticeAccepted?.version ?? ''
      this.traceNoticeVersion =
        config.privacy.traceNoticeAccepted?.version ?? ''
      this.yoloNoticeVersion = config.privacy.yoloNoticeAccepted?.version ?? ''
      this.credentialConfiguredValue =
        config.providers.deepseek.credentialConfigured
      this.builtinPolicies = config.permission.builtinPolicies
      this.rememberedRules = toUiRememberedRules(config)
      this.providerForm.baseURL = config.providers.deepseek.baseURL
      this.providerForm.model = config.providers.deepseek.model
      this.providerForm.reasoning = config.providers.deepseek.reasoning
      this.providerForm.approverModel = config.approval.approverModel
      this.modelOverrides = structuredClone(
        config.providers.deepseek.modelOverrides,
      )
      this.limitsConfig = structuredClone(config.limits)
      this.providerForm.tokenEstimationMode = config.limits.tokenEstimation.mode
      this.providerForm.bytesPerToken =
        config.limits.tokenEstimation.bytesPerToken
      this.syncModelOverride(config.providers.deepseek.model)
      this.permissionForm.sensitiveMode = config.permission.sensitiveData.mode
      this.permissionForm.pathGlobs =
        config.permission.sensitiveData.pathGlobs.join('\n')
      this.permissionForm.contentPatterns =
        config.permission.sensitiveData.contentPatterns.join('\n')
      this.loggingForm.enabled = config.logging.enabled
      this.loggingForm.retentionDays = config.logging.retentionDays
      this.loggingForm.maxTotalMegabytes = Math.max(
        1,
        Math.round(config.logging.maxTotalBytes / 1_000_000),
      )
    },
    registerProject(workspacePath: string) {
      if (!this.projects.some((project) => project.path === workspacePath)) {
        this.projects.push({
          path: workspacePath,
          name: projectName(workspacePath),
          addedAt: new Date().toISOString(),
        })
      }
    },
    createConversation(workspacePath?: string) {
      const targetWorkspace = workspacePath ?? this.workspacePath

      if (!targetWorkspace) {
        return undefined
      }

      const now = new Date().toISOString()
      const conversation: ConversationRecord = {
        id: requestId(),
        projectPath: targetWorkspace,
        title: 'New conversation',
        model: this.providerForm.model,
        mode: this.mode,
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      this.registerProject(targetWorkspace)
      this.conversations.push(conversation)
      this.activeConversationId = conversation.id
      this.sessionId = undefined
      this.messages = []
      this.tools = []
      this.pendingApproval = undefined
      this.persistWorkbench()
      return conversation
    },
    async newConversation() {
      if (!this.workspacePath) {
        const selected = await this.chooseWorkspace()

        if (!selected) {
          return false
        }
      }

      this.saveActiveConversation()
      this.createConversation()
      return true
    },
    async selectConversation(conversationId: string) {
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )

      if (!conversation || conversationId === this.activeConversationId) {
        return Boolean(conversation)
      }

      if (this.activeRunId || this.pendingApproval) {
        return false
      }

      this.saveActiveConversation()
      await this.activateWorkspace(conversation.projectPath)
      this.activeConversationId = conversation.id
      this.restoreActiveConversation()
      this.persistWorkbench()
      return true
    },
    renameConversation(conversationId: string, title: string) {
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )
      const normalized = title.trim().slice(0, 120)

      if (!conversation || !normalized) {
        return
      }

      conversation.title = normalized
      conversation.updatedAt = new Date().toISOString()
      this.persistWorkbench()
    },
    async deleteConversation(conversationId: string) {
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )

      if (!conversation || this.activeRunId || this.pendingApproval) {
        return false
      }

      if (this.sessionIdsByConversation[conversationId]) {
        await this.closeRuntimeSession(conversationId)
      }

      this.conversations = this.conversations.filter(
        (item) => item.id !== conversationId,
      )

      if (conversationId === this.activeConversationId) {
        const next = this.conversations
          .filter((item) => item.projectPath === conversation.projectPath)
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          )[0]
        this.activeConversationId = next?.id

        if (!next && this.workspacePath) {
          this.createConversation(this.workspacePath)
        } else {
          this.restoreActiveConversation()
        }
      }

      this.persistWorkbench()
      return true
    },
    async removeCurrentProject() {
      if (!this.workspacePath || this.activeRunId || this.pendingApproval) {
        return false
      }

      const removedPath = this.workspacePath
      const projectConversationIds = this.conversations
        .filter((conversation) => conversation.projectPath === removedPath)
        .map((conversation) => conversation.id)

      await Promise.all(
        projectConversationIds.map((conversationId) =>
          this.closeRuntimeSession(conversationId),
        ),
      )
      this.projects = this.projects.filter(
        (project) => project.path !== removedPath,
      )
      this.conversations = this.conversations.filter(
        (conversation) => conversation.projectPath !== removedPath,
      )
      this.workspacePath = ''
      this.activeConversationId = undefined
      this.messages = []
      const bridge = api()

      if (bridge) {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'workspace',
        })

        if (result.ok) {
          this.applyConfig(result.value.config)
        }
      }

      this.persistWorkbench()
      return true
    },
    restoreActiveConversation() {
      const conversation = this.conversations.find(
        (item) => item.id === this.activeConversationId,
      )
      this.messages = conversation ? cloneMessages(conversation.messages) : []
      this.sessionId = conversation
        ? this.sessionIdsByConversation[conversation.id]
        : undefined

      if (conversation) {
        this.workspacePath = conversation.projectPath
        this.mode = conversation.mode
      }

      this.tools = []
      this.pendingApproval = undefined
      this.error = ''
    },
    saveActiveConversation() {
      const conversation = this.conversations.find(
        (item) => item.id === this.activeConversationId,
      )

      if (!conversation) {
        return
      }

      conversation.messages = cloneMessages(this.messages)
      conversation.mode = this.mode
      conversation.model = this.providerForm.model
      conversation.updatedAt = new Date().toISOString()
    },
    schedulePersist() {
      this.saveActiveConversation()

      if (persistTimer !== undefined) {
        window.clearTimeout(persistTimer)
      }

      persistTimer = window.setTimeout(() => {
        this.persistWorkbench()
        persistTimer = undefined
      }, 250)
    },
    persistWorkbench() {
      try {
        window.localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify({
            projects: this.projects,
            conversations: this.conversations,
            activeConversationId: this.activeConversationId,
          } satisfies PersistedWorkbench),
        )
      } catch {
        // History persistence is best effort; runtime behavior remains usable.
      }
    },
    async activateWorkspace(workspacePath: string) {
      this.workspacePath = workspacePath
      this.registerProject(workspacePath)
      const bridge = api()

      if (!bridge) {
        return
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'workspace',
        lastOpened: workspacePath,
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
      } else {
        this.error = result.error.message
      }
    },
    async chooseWorkspace() {
      const bridge = api()

      if (!bridge) {
        return undefined
      }

      const result = await bridge.chooseWorkspace({ version: IPC_VERSION })

      if (!result.ok) {
        this.error = result.error.message
        return undefined
      }

      if (!result.value.path) {
        return undefined
      }

      this.workspacePath = result.value.path
      this.registerProject(result.value.path)
      const latest = this.conversations
        .filter(
          (conversation) => conversation.projectPath === result.value.path,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]

      if (latest) {
        this.activeConversationId = latest.id
        this.restoreActiveConversation()
      } else {
        this.createConversation(result.value.path)
      }

      this.persistWorkbench()
      return result.value.path
    },
    setMode(mode: PermissionMode) {
      this.mode = mode
      this.schedulePersist()
    },
    syncModelOverride(model: string) {
      const override = this.modelOverrides[model]
      this.providerForm.contextWindowTokens =
        override?.contextWindowTokens ?? null
      this.providerForm.maxOutputTokens = override?.maxOutputTokens ?? null
    },
    setProviderModel(model: string) {
      this.providerForm.model = model
      this.syncModelOverride(model)

      if (!this.modelProfiles.some((candidate) => candidate.id === model)) {
        const fallbackContext = this.limitsConfig?.maxContextTokens ?? 64_000
        this.modelProfiles.push({
          id: model,
          availability: 'custom',
          capabilitySource: 'default',
          contextWindowTokens: fallbackContext,
        })
      }
    },
    async loadProviderModels(refresh: boolean) {
      const bridge = api()

      if (!bridge || this.modelCatalogLoading) {
        return
      }

      this.modelCatalogLoading = true

      try {
        const result = await bridge.listProviderModels({
          version: IPC_VERSION,
          refresh,
        })

        if (!result.ok) {
          if (refresh) {
            this.error = result.error.message
          }
          return
        }

        this.modelProfiles = result.value.models
        this.modelCatalogFetchedAt = result.value.fetchedAt
        this.modelCatalogStale = result.value.stale
      } finally {
        this.modelCatalogLoading = false
      }
    },
    async saveProvider() {
      const bridge = api()

      if (!bridge) {
        return
      }

      this.error = ''
      const provider = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'provider',
        baseURL: this.providerForm.baseURL,
        model: this.providerForm.model,
        contextWindowTokens: this.providerForm.contextWindowTokens,
        maxOutputTokens: this.providerForm.maxOutputTokens,
        reasoning: this.providerForm.reasoning,
      })

      if (!provider.ok) {
        this.error = provider.error.message
        return
      }

      this.applyConfig(provider.value.config)

      const approval = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'approval',
        approverProvider: 'deepseek',
        approverModel: this.providerForm.approverModel,
      })

      if (approval.ok) {
        this.applyConfig(approval.value.config)
      } else {
        this.error = approval.error.message
      }

      if (this.limitsConfig) {
        const limits = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'limits',
          value: {
            ...this.limitsConfig,
            tokenEstimation: {
              mode: this.providerForm.tokenEstimationMode,
              bytesPerToken: this.providerForm.bytesPerToken,
            },
          },
        })

        if (limits.ok) {
          this.applyConfig(limits.value.config)
        } else {
          this.error = limits.error.message
        }
      }

      if (this.providerForm.apiKey.trim()) {
        const credential = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'credential',
          action: 'set',
          apiKey: this.providerForm.apiKey.trim(),
        })

        if (credential.ok) {
          this.providerForm.apiKey = ''
          this.applyConfig(credential.value.config)
        } else {
          this.error = credential.error.message
        }
      }

      this.schedulePersist()
    },
    async clearCredential() {
      const bridge = api()

      if (!bridge) {
        return
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'credential',
        action: 'clear',
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
      } else {
        this.error = result.error.message
      }
    },
    async savePermissions() {
      const bridge = api()

      if (!bridge) {
        return
      }

      const lines = (value: string) =>
        value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'permission',
        builtinPolicies: this.builtinPolicies,
        rememberedRules: this.rememberedRules.map((rule) => ({
          ...rule,
          argConstraints: JSON.parse(rule.argConstraints),
        })),
        sensitiveData: {
          mode: this.permissionForm.sensitiveMode,
          pathGlobs: lines(this.permissionForm.pathGlobs),
          contentPatterns: lines(this.permissionForm.contentPatterns),
        },
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
      } else {
        this.error = result.error.message
      }
    },
    async removeRememberedRule(ruleId: string) {
      this.rememberedRules = this.rememberedRules.filter(
        (rule) => rule.id !== ruleId,
      )
      await this.savePermissions()
    },
    async saveLogging() {
      const bridge = api()

      if (!bridge) {
        return
      }

      if (this.loggingForm.enabled && !this.traceNoticeAccepted) {
        const notice = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'privacy',
          traceNoticeAccepted: nowNotice(TRACE_NOTICE_VERSION),
        })

        if (!notice.ok) {
          this.error = notice.error.message
          return
        }

        this.applyConfig(notice.value.config)
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'logging',
        value: {
          enabled: this.loggingForm.enabled,
          retentionDays: Math.max(1, this.loggingForm.retentionDays),
          maxTotalBytes: Math.max(
            1_024,
            Math.round(this.loggingForm.maxTotalMegabytes * 1_000_000),
          ),
        },
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
      } else {
        this.error = result.error.message
      }
    },
    async acceptProviderNotice() {
      const bridge = api()

      if (!bridge) {
        return
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'privacy',
        providerNoticeAccepted: nowNotice(PROVIDER_NOTICE_VERSION),
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
      } else {
        this.error = result.error.message
      }
    },
    async acceptYoloNotice() {
      const bridge = api()

      if (!bridge) {
        return false
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'privacy',
        yoloNoticeAccepted: nowNotice(YOLO_NOTICE_VERSION),
      })

      if (result.ok) {
        this.applyConfig(result.value.config)
        return true
      }

      this.error = result.error.message
      return false
    },
    async createSession() {
      const bridge = api()

      if (!bridge || !this.workspacePath) {
        return false
      }

      this.error = ''
      const result = await bridge.createSession({
        version: IPC_VERSION,
        workspace: this.workspacePath,
        mode: this.mode,
        provider: 'deepseek',
      })

      if (result.ok) {
        this.sessionId = result.value.sessionId
        if (this.activeConversationId) {
          this.sessionIdsByConversation[this.activeConversationId] =
            result.value.sessionId
        }
        return true
      }

      this.error = result.error.message
      return false
    },
    async closeRuntimeSession(conversationId?: string) {
      const bridge = api()
      const targetConversationId = conversationId ?? this.activeConversationId
      const sessionId = targetConversationId
        ? this.sessionIdsByConversation[targetConversationId]
        : undefined

      if (targetConversationId) {
        delete this.sessionIdsByConversation[targetConversationId]
      }

      if (targetConversationId === this.activeConversationId) {
        this.sessionId = undefined
        this.activeRunId = undefined
        this.pendingApproval = undefined
        this.runStatus = 'idle'
        this.tools = []
      }

      if (bridge && sessionId) {
        await bridge.closeSession({
          version: IPC_VERSION,
          sessionId,
        })
      }
    },
    async sendMessage() {
      const bridge = api()
      const text = this.input.trim()

      if (!bridge || !text || !this.canSend) {
        return
      }

      if (!this.sessionId && !(await this.createSession())) {
        return
      }

      const sessionId = this.sessionId

      if (!sessionId) {
        return
      }

      this.input = ''
      this.messages.push({
        id: requestId(),
        role: 'user',
        text,
        reasoning: '',
      })
      const conversation = this.conversations.find(
        (item) => item.id === this.activeConversationId,
      )

      if (conversation?.title === 'New conversation') {
        conversation.title = text.replace(/\s+/g, ' ').slice(0, 56)
      }

      this.schedulePersist()
      const result = await bridge.startRun({
        version: IPC_VERSION,
        sessionId,
        message: text,
        clientRequestId: requestId(),
      })

      if (result.ok) {
        this.activeRunId = result.value.runId
      } else {
        this.error = result.error.message
      }
    },
    async interruptRun() {
      const bridge = api()

      if (!bridge || !this.sessionId || !this.activeRunId) {
        return
      }

      await bridge.interruptRun({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        runId: this.activeRunId,
      })
    },
    async decideApproval(decision: 'allow' | 'deny', remember = false) {
      const bridge = api()

      if (!bridge || !this.sessionId || !this.pendingApproval) {
        return
      }

      const pending = this.pendingApproval
      const result = await bridge.decideApproval({
        version: IPC_VERSION,
        sessionId: this.sessionId,
        runId: pending.runId,
        callId: pending.callId,
        decision,
        remember:
          decision === 'allow' && remember && pending.rememberable
            ? {
                workspaceScope: 'workspace',
                expiresAt: new Date(
                  Date.now() + 30 * 24 * 60 * 60_000,
                ).toISOString(),
              }
            : undefined,
      })

      if (result.ok) {
        this.pendingApproval = undefined
      } else {
        this.error = result.error.message
      }
    },
    handleAgentEvent(event: AgentEvent) {
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

      if (event.sessionId !== this.sessionId) {
        return
      }

      switch (event.type) {
        case 'run.status':
          this.runStatus = event.status
          this.activeRunId =
            event.status === 'completed' ||
            event.status === 'cancelled' ||
            event.status === 'failed'
              ? undefined
              : event.runId

          if (event.error) {
            this.error = event.error.message
          }

          if (!this.activeRunId) {
            this.schedulePersist()
          }
          break
        case 'assistant.text.delta':
          this.assistantMessage(event.runId).text += event.delta
          this.schedulePersist()
          break
        case 'assistant.reasoning.delta':
          this.assistantMessage(event.runId).reasoning += event.delta
          this.schedulePersist()
          break
        case 'tool.proposed':
          this.tools.unshift({
            callId: event.callId,
            runId: event.runId,
            tool: event.tool,
            args: event.args,
            reason: event.reason,
            status: 'proposed',
          })
          break
        case 'tool.completed': {
          const tool = this.tools.find((item) => item.callId === event.callId)

          if (tool) {
            tool.status = 'completed'
            tool.result = event.result
          }
          break
        }
        case 'approval.requested':
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
            expiresAt: event.expiresAt,
          }
          break
      }
    },
    assistantMessage(runId: RunId): ChatMessage {
      let message = this.messages.find(
        (item) => item.role === 'assistant' && item.runId === runId,
      )

      if (!message) {
        message = {
          id: requestId(),
          role: 'assistant',
          runId,
          text: '',
          reasoning: '',
        }
        this.messages.push(message)
      }

      return message
    },
  },
})
