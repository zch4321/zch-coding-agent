import { contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, IpcInvoke } from '../shared/agent-api'
import {
  APP_NOTIFICATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_EXECUTION_EVENT_CHANNEL,
  DOMAIN_STATE_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
} from '../shared/channels'
import type {
  AgentEventEnvelope,
  AgentExecutionEventEnvelope,
  BackendNotificationEnvelope,
  DomainStateDelivery,
  TerminalEventEnvelope,
} from '../shared/ipc-contract'
import { BackendNotificationEnvelopeSchema } from '../shared/notifications'
import type { DomainStateEvent } from '../shared/domain-state-api'
import { compileSchema } from './schema-validator'
import { BackendNotificationBuffer } from './preload-notification-buffer'

const invoke: IpcInvoke = (channel, payload) =>
  ipcRenderer.invoke(channel, payload)

const validateBackendNotification = compileSchema(
  BackendNotificationEnvelopeSchema,
)
const backendNotifications = new BackendNotificationBuffer({ capacity: 64 })

ipcRenderer.on(APP_NOTIFICATION_CHANNEL, (_event, payload: unknown) => {
  if (!validateBackendNotification(payload)) {
    console.error('Rejected invalid backend notification')
    return
  }
  backendNotifications.push(payload as BackendNotificationEnvelope)
})

function subscribe<Event>(
  channel: string,
  listener: (event: Event) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: Event) => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const MAX_BUFFERED_DOMAIN_EVENTS = 256
const domainListeners = new Set<(event: DomainStateDelivery) => void>()
const bufferedDomainEvents: DomainStateEvent[] = []
let domainBufferOverflowed = false

ipcRenderer.on(
  DOMAIN_STATE_EVENT_CHANNEL,
  (_event, event: DomainStateEvent) => {
    if (domainListeners.size > 0) {
      for (const listener of domainListeners) {
        listener({ kind: 'commit', event })
      }
      return
    }
    if (bufferedDomainEvents.length >= MAX_BUFFERED_DOMAIN_EVENTS) {
      bufferedDomainEvents.length = 0
      domainBufferOverflowed = true
      return
    }
    if (!domainBufferOverflowed) bufferedDomainEvents.push(event)
  },
)

function subscribeDomainState(
  listener: (event: DomainStateDelivery) => void,
): () => void {
  domainListeners.add(listener)
  if (domainBufferOverflowed) {
    domainBufferOverflowed = false
    bufferedDomainEvents.length = 0
    listener({ kind: 'buffer_overflow' })
  } else {
    for (const event of bufferedDomainEvents.splice(0)) {
      listener({ kind: 'commit', event })
    }
  }
  return () => domainListeners.delete(listener)
}

const api: AgentApi = {
  getConfig: (payload) => invoke('config:get', payload),
  setConfig: (payload) => invoke('config:set', payload),
  listCommandShells: (payload) => invoke('command-shell:list', payload),
  listMcpServers: (payload) => invoke('mcp:list', payload),
  reloadMcpConfig: (payload) => invoke('mcp:reload', payload),
  trustAndEnableMcpServer: (payload) => invoke('mcp:trust-enable', payload),
  disableMcpServer: (payload) => invoke('mcp:disable', payload),
  restartMcpServer: (payload) => invoke('mcp:restart', payload),
  listProviderModels: (payload) => invoke('provider:list-models', payload),
  getBootstrap: (payload) => invoke('app:get-bootstrap', payload),
  listProjects: (payload) => invoke('project:list', payload),
  addProject: (payload) => invoke('project:add', payload),
  updateProjectRecord: (payload) => invoke('project:update', payload),
  removeProject: (payload) => invoke('project:remove', payload),
  listSessions: (payload) => invoke('session:list', payload),
  getSession: (payload) => invoke('session:get', payload),
  updateSession: (payload) => invoke('session:update', payload),
  archiveSession: (payload) => invoke('session:archive', payload),
  restoreSession: (payload) => invoke('session:restore', payload),
  deleteSession: (payload) => invoke('session:delete', payload),
  forkSession: (payload) => invoke('session:fork', payload),
  rewindSession: (payload) => invoke('session:rewind', payload),
  searchSessions: (payload) => invoke('session:search', payload),
  exportConversationMarkdown: (payload) =>
    invoke('session:export-markdown', payload),
  listMessages: (payload) => invoke('message:list', payload),
  searchMessages: (payload) => invoke('message:search', payload),
  listFileChanges: (payload) => invoke('file-change:list', payload),
  revertFileChange: (payload) => invoke('file-change:revert', payload),
  listAgentExecutions: (payload) => invoke('agent-execution:list', payload),
  getAgentExecution: (payload) => invoke('agent-execution:get', payload),
  chooseWorkspace: (payload) => invoke('workspace:choose', payload),
  listWorkspaceDirectory: (payload) =>
    invoke('workspace:list-directory', payload),
  readWorkspaceFile: (payload) => invoke('workspace:read-file', payload),
  openWorkspaceFile: (payload) => invoke('workspace:open-file', payload),
  chooseWorkspaceContext: (payload) =>
    invoke('workspace:choose-context', payload),
  getProject: (payload) => invoke('project:get', payload),
  saveProject: (payload) => invoke('project:save', payload),
  detectProjectModules: (payload) => invoke('project:detect-modules', payload),
  getProjectBackendStatus: (payload) =>
    invoke('project:backend-status', payload),
  restartProjectBackend: (payload) =>
    invoke('project:restart-backend', payload),
  updatePlanStatus: (payload) => invoke('plan:update-status', payload),
  startRun: (payload) => invoke('run:start', payload),
  retryRun: (payload) => invoke('run:retry', payload),
  interruptRun: (payload) => invoke('run:interrupt', payload),
  interjectRun: (payload) => invoke('run:interject', payload),
  decideApproval: (payload) => invoke('approval:decide', payload),
  sendTerminalInput: (payload) => invoke('terminal:input', payload),
  openTerminal: (payload) => invoke('terminal:open', payload),
  listTerminals: (payload) => invoke('terminal:list', payload),
  resizeTerminal: (payload) => invoke('terminal:resize', payload),
  closeTerminal: (payload) => invoke('terminal:close', payload),
  getTerminalSnapshot: (payload) => invoke('terminal:snapshot', payload),
  minimizeWindow: (payload) => invoke('window:minimize', payload),
  toggleMaximizeWindow: (payload) => invoke('window:toggle-maximize', payload),
  closeWindow: (payload) => invoke('window:close', payload),
  listSkills: (payload) => invoke('skills:list', payload),
  installSkillFromUrl: (payload) => invoke('skills:installFromUrl', payload),
  chooseAndInstallSkill: (payload) =>
    invoke('skills:chooseAndInstallFile', payload),
  refreshSkills: (payload) => invoke('skills:refresh', payload),
  setSkillEnabled: (payload) => invoke('skills:setEnabled', payload),
  listTraces: (payload) => invoke('trace:list', payload),
  replayTrace: (payload) => invoke('trace:replay', payload),
  getSessionTranscriptPage: (payload) =>
    invoke('trace:transcript-page', payload),
  getSessionTranscriptRequestMessages: (payload) =>
    invoke('trace:request-messages', payload),
  exportSessionTranscript: (payload) =>
    invoke('trace:export-transcript', payload),
  getTraceStats: (payload) => invoke('trace:stats', payload),
  openLogDirectory: (payload) => invoke('logs:open-directory', payload),
  clearClosedTraces: (payload) => invoke('logs:clear-closed', payload),
  onAgentEvent: (listener) =>
    subscribe<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, listener),
  onAgentExecutionEvent: (listener) =>
    subscribe<AgentExecutionEventEnvelope>(
      AGENT_EXECUTION_EVENT_CHANNEL,
      listener,
    ),
  onBackendNotification: (listener) => backendNotifications.subscribe(listener),
  onTerminalEvent: (listener) =>
    subscribe<TerminalEventEnvelope>(TERMINAL_EVENT_CHANNEL, listener),
  onDomainStateEvent: subscribeDomainState,
}
const agentApi = Object.freeze(api)

contextBridge.exposeInMainWorld('agentApi', agentApi)
