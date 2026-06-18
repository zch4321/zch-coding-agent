import { defineStore } from 'pinia'
import type { AgentEvent } from '../../shared/agent-events'
import type { AgentApi } from '../../shared/agent-api'
import type { PermissionMode, PublicConfig } from '../../shared/config'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { IPC_VERSION } from '../../shared/channels'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
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
  signals: Array<{ code: string; severity: string; detail: string }>
  expiresAt: string
}

interface UiConfig {
  providers: PublicConfig['providers']
  privacy: PublicConfig['privacy']
  logging: PublicConfig['logging']
  workspace: PublicConfig['workspace']
}

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

function toUiConfig(config: PublicConfig): UiConfig {
  return {
    providers: config.providers,
    privacy: config.privacy,
    logging: config.logging,
    workspace: config.workspace,
  }
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    initialized: false,
    bridgeAvailable: false,
    config: undefined as UiConfig | undefined,
    workspacePath: '',
    sessionId: undefined as SessionId | undefined,
    activeRunId: undefined as RunId | undefined,
    runStatus: 'idle',
    mode: 'readonly' as PermissionMode,
    input: '',
    messages: [] as ChatMessage[],
    tools: [] as ToolActivity[],
    pendingApproval: undefined as PendingApproval | undefined,
    error: '',
    providerForm: {
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      reasoning: 'auto' as 'auto' | 'off',
      apiKey: '',
    },
    traceLoggingRequested: false,
    unsubscribers: [] as Array<() => void>,
  }),
  getters: {
    providerNoticeAccepted: (state) =>
      state.config?.privacy.providerNoticeAccepted?.version ===
      PROVIDER_NOTICE_VERSION,
    traceNoticeAccepted: (state) =>
      state.config?.privacy.traceNoticeAccepted?.version ===
      TRACE_NOTICE_VERSION,
    credentialConfigured: (state) =>
      Boolean(state.config?.providers.deepseek.credentialConfigured),
    canCreateSession: (state) =>
      Boolean(
        state.bridgeAvailable &&
        state.config?.privacy.providerNoticeAccepted?.version ===
          PROVIDER_NOTICE_VERSION &&
        state.config.providers.deepseek.credentialConfigured &&
        state.workspacePath &&
        !state.sessionId,
      ),
    canSend: (state) =>
      Boolean(
        state.sessionId &&
        !state.activeRunId &&
        state.input.trim().length > 0 &&
        !state.pendingApproval,
      ),
  },
  actions: {
    async initialize() {
      if (this.initialized) {
        return
      }

      const bridge = api()
      this.bridgeAvailable = Boolean(bridge)

      if (!bridge) {
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
      } else {
        this.error = result.error.message
      }

      this.unsubscribers.push(
        bridge.onAgentEvent((envelope) =>
          this.handleAgentEvent(envelope.event),
        ),
      )
      this.initialized = true
    },
    dispose() {
      for (const unsubscribe of this.unsubscribers.splice(0)) {
        unsubscribe()
      }
    },
    applyConfig(config: PublicConfig) {
      this.config = toUiConfig(config)
      this.providerForm.baseURL = config.providers.deepseek.baseURL
      this.providerForm.model = config.providers.deepseek.model
      this.providerForm.reasoning = config.providers.deepseek.reasoning
      this.traceLoggingRequested = config.logging.enabled
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
        reasoning: this.providerForm.reasoning,
      })

      if (!provider.ok) {
        this.error = provider.error.message
        return
      }

      this.applyConfig(provider.value.config)

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
    async setTraceLogging(enabled: boolean) {
      const bridge = api()

      if (!bridge || !this.config) {
        return
      }

      this.error = ''

      if (enabled && !this.traceNoticeAccepted) {
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
          ...this.config.logging,
          enabled,
        },
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
        return
      }

      const result = await bridge.chooseWorkspace({ version: IPC_VERSION })

      if (result.ok && result.value.path) {
        this.workspacePath = result.value.path
      } else if (!result.ok) {
        this.error = result.error.message
      }
    },
    async createSession() {
      const bridge = api()

      if (!bridge || !this.workspacePath) {
        return
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
        this.messages = []
        this.tools = []
      } else {
        this.error = result.error.message
      }
    },
    async closeSession() {
      const bridge = api()

      if (!bridge || !this.sessionId) {
        return
      }

      await bridge.closeSession({
        version: IPC_VERSION,
        sessionId: this.sessionId,
      })
    },
    async sendMessage() {
      const bridge = api()

      if (!bridge || !this.sessionId || !this.input.trim()) {
        return
      }

      const text = this.input.trim()
      this.input = ''
      this.messages.push({
        id: requestId(),
        role: 'user',
        text,
        reasoning: '',
      })
      const result = await bridge.startRun({
        version: IPC_VERSION,
        sessionId: this.sessionId,
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
    async decideApproval(decision: 'allow' | 'deny') {
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
      })

      if (result.ok) {
        this.pendingApproval = undefined
      } else {
        this.error = result.error.message
      }
    },
    handleAgentEvent(event: AgentEvent) {
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
          break
        case 'assistant.text.delta':
          this.assistantMessage(event.runId).text += event.delta
          break
        case 'assistant.reasoning.delta':
          this.assistantMessage(event.runId).reasoning += event.delta
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
            signals: event.policySignals,
            expiresAt: event.expiresAt,
          }
          break
        case 'session.closed':
          this.sessionId = undefined
          this.activeRunId = undefined
          this.pendingApproval = undefined
          this.runStatus = 'idle'
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
