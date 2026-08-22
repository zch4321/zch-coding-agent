import type {
  AgentEventEnvelope,
  AgentExecutionEventEnvelope,
  DomainStateDelivery,
  TerminalEventEnvelope,
} from './ipc/events'
import type { IpcChannel, IpcPayload, IpcResult } from './ipc/registry'
import type { BackendNotificationEnvelope } from './notifications'

export type IpcInvoke = <Channel extends IpcChannel>(
  channel: Channel,
  payload: IpcPayload<Channel>,
) => Promise<IpcResult<Channel>>

/**
 * Explicit Renderer capability allowlist for request/response IPC methods.
 * Method names stay ergonomic while every target must be a registered channel.
 */
export const AGENT_API_INVOKE_ROUTES = Object.freeze({
  getConfig: 'config:get',
  setConfig: 'config:set',
  listCommandShells: 'command-shell:list',
  listMcpServers: 'mcp:list',
  reloadMcpConfig: 'mcp:reload',
  trustAndEnableMcpServer: 'mcp:trust-enable',
  disableMcpServer: 'mcp:disable',
  restartMcpServer: 'mcp:restart',
  listProviderModels: 'provider:list-models',
  getBootstrap: 'app:get-bootstrap',
  listProjects: 'project:list',
  addProject: 'project:add',
  updateProjectRecord: 'project:update',
  removeProject: 'project:remove',
  listSessions: 'session:list',
  getSession: 'session:get',
  updateSession: 'session:update',
  archiveSession: 'session:archive',
  restoreSession: 'session:restore',
  deleteSession: 'session:delete',
  forkSession: 'session:fork',
  rewindSession: 'session:rewind',
  searchSessions: 'session:search',
  exportConversationMarkdown: 'session:export-markdown',
  listMessages: 'message:list',
  searchMessages: 'message:search',
  listFileChanges: 'file-change:list',
  revertFileChange: 'file-change:revert',
  listAgentExecutions: 'agent-execution:list',
  getAgentExecution: 'agent-execution:get',
  chooseWorkspace: 'workspace:choose',
  listWorkspaceDirectory: 'workspace:list-directory',
  readWorkspaceFile: 'workspace:read-file',
  openWorkspaceFile: 'workspace:open-file',
  chooseWorkspaceContext: 'workspace:choose-context',
  getProject: 'project:get',
  saveProject: 'project:save',
  detectProjectModules: 'project:detect-modules',
  getProjectBackendStatus: 'project:backend-status',
  restartProjectBackend: 'project:restart-backend',
  updatePlanStatus: 'plan:update-status',
  startRun: 'run:start',
  retryRun: 'run:retry',
  interruptRun: 'run:interrupt',
  interjectRun: 'run:interject',
  decideApproval: 'approval:decide',
  sendTerminalInput: 'terminal:input',
  openTerminal: 'terminal:open',
  listTerminals: 'terminal:list',
  resizeTerminal: 'terminal:resize',
  closeTerminal: 'terminal:close',
  getTerminalSnapshot: 'terminal:snapshot',
  minimizeWindow: 'window:minimize',
  toggleMaximizeWindow: 'window:toggle-maximize',
  closeWindow: 'window:close',
  listSkills: 'skills:list',
  installSkillFromUrl: 'skills:installFromUrl',
  chooseAndInstallSkill: 'skills:chooseAndInstallFile',
  refreshSkills: 'skills:refresh',
  setSkillEnabled: 'skills:setEnabled',
  listTraces: 'trace:list',
  replayTrace: 'trace:replay',
  getSessionTranscriptPage: 'trace:transcript-page',
  getSessionTranscriptRequestMessages: 'trace:request-messages',
  exportSessionTranscript: 'trace:export-transcript',
  getTraceStats: 'trace:stats',
  openLogDirectory: 'logs:open-directory',
  clearClosedTraces: 'logs:clear-closed',
  getRuntimeLogStatus: 'runtime-log:status',
  openRuntimeLogDirectory: 'runtime-log:open-directory',
  clearRuntimeLogs: 'runtime-log:clear',
} as const satisfies Record<string, IpcChannel>)

type AgentApiInvokeRoutes = typeof AGENT_API_INVOKE_ROUTES
type AgentInvokeMethod<Channel extends IpcChannel> = (
  payload: IpcPayload<Channel>,
) => Promise<IpcResult<Channel>>

export type AgentInvokeApi = {
  [Method in keyof AgentApiInvokeRoutes]: AgentInvokeMethod<
    AgentApiInvokeRoutes[Method]
  >
}

type Unsubscribe = () => void

export interface AgentApiSubscriptionEventMap {
  agentEvent: AgentEventEnvelope
  agentExecutionEvent: AgentExecutionEventEnvelope
  backendNotification: BackendNotificationEnvelope
  terminalEvent: TerminalEventEnvelope
  domainState: DomainStateDelivery
}

/** Maps public subscription methods to preload-owned subscription adapters. */
export const AGENT_API_SUBSCRIPTION_ROUTES = Object.freeze({
  onAgentEvent: 'agentEvent',
  onAgentExecutionEvent: 'agentExecutionEvent',
  onBackendNotification: 'backendNotification',
  onTerminalEvent: 'terminalEvent',
  onDomainStateEvent: 'domainState',
} as const satisfies Record<string, keyof AgentApiSubscriptionEventMap>)

type AgentApiSubscriptionRoutes = typeof AGENT_API_SUBSCRIPTION_ROUTES

export type AgentSubscriptionApi = {
  [Method in keyof AgentApiSubscriptionRoutes]: (
    listener: (
      event: AgentApiSubscriptionEventMap[AgentApiSubscriptionRoutes[Method]],
    ) => void,
  ) => Unsubscribe
}

export type AgentApiSubscriptionAdapters = {
  [Adapter in keyof AgentApiSubscriptionEventMap]: (
    listener: (event: AgentApiSubscriptionEventMap[Adapter]) => void,
  ) => Unsubscribe
}

export type AgentApi = AgentInvokeApi & AgentSubscriptionApi

type ObjectEntry<Value extends object> = {
  [Key in keyof Value]-?: [Key, Value[Key]]
}[keyof Value]

function objectEntries<Value extends object>(
  value: Value,
): ObjectEntry<Value>[] {
  return Object.entries(value) as ObjectEntry<Value>[]
}

function objectKeys<Value extends object>(value: Value): (keyof Value)[] {
  return Object.keys(value) as (keyof Value)[]
}

function bindInvoke<Channel extends IpcChannel>(
  invoke: IpcInvoke,
  channel: Channel,
): AgentInvokeMethod<Channel> {
  return (payload) => invoke(channel, payload)
}

/**
 * Builds the fixed Renderer API from the capability manifest and explicit
 * subscription adapters.
 */
export function createAgentApi(
  invoke: IpcInvoke,
  subscriptionAdapters: AgentApiSubscriptionAdapters,
): AgentApi {
  const invokeMethods = Object.fromEntries(
    objectEntries(AGENT_API_INVOKE_ROUTES).map(([method, channel]) => [
      method,
      bindInvoke(invoke, channel),
    ]),
  ) as AgentInvokeApi
  const subscriptionMethods = Object.fromEntries(
    objectEntries(AGENT_API_SUBSCRIPTION_ROUTES).map(([method, adapter]) => [
      method,
      subscriptionAdapters[adapter],
    ]),
  ) as AgentSubscriptionApi

  return Object.assign(invokeMethods, subscriptionMethods)
}

export const AGENT_API_KEYS = Object.freeze([
  ...objectKeys(AGENT_API_INVOKE_ROUTES),
  ...objectKeys(AGENT_API_SUBSCRIPTION_ROUTES),
]) satisfies readonly (keyof AgentApi)[]
