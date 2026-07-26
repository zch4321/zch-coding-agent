import type {
  AgentEventEnvelope,
  BackendNotificationEnvelope,
  DomainStateDelivery,
  IpcChannel,
  IpcPayload,
  IpcResult,
  TerminalEventEnvelope,
} from './ipc-contract'

export type IpcInvoke = <Channel extends IpcChannel>(
  channel: Channel,
  payload: IpcPayload<Channel>,
) => Promise<IpcResult<Channel>>

type Unsubscribe = () => void

export interface AgentApi {
  getConfig(payload: IpcPayload<'config:get'>): Promise<IpcResult<'config:get'>>
  setConfig(payload: IpcPayload<'config:set'>): Promise<IpcResult<'config:set'>>
  listMcpServers(
    payload: IpcPayload<'mcp:list'>,
  ): Promise<IpcResult<'mcp:list'>>
  reloadMcpConfig(
    payload: IpcPayload<'mcp:reload'>,
  ): Promise<IpcResult<'mcp:reload'>>
  trustAndEnableMcpServer(
    payload: IpcPayload<'mcp:trust-enable'>,
  ): Promise<IpcResult<'mcp:trust-enable'>>
  disableMcpServer(
    payload: IpcPayload<'mcp:disable'>,
  ): Promise<IpcResult<'mcp:disable'>>
  restartMcpServer(
    payload: IpcPayload<'mcp:restart'>,
  ): Promise<IpcResult<'mcp:restart'>>
  listProviderModels(
    payload: IpcPayload<'provider:list-models'>,
  ): Promise<IpcResult<'provider:list-models'>>
  getBootstrap(
    payload: IpcPayload<'app:get-bootstrap'>,
  ): Promise<IpcResult<'app:get-bootstrap'>>
  listProjects(
    payload: IpcPayload<'project:list'>,
  ): Promise<IpcResult<'project:list'>>
  addProject(
    payload: IpcPayload<'project:add'>,
  ): Promise<IpcResult<'project:add'>>
  updateProjectRecord(
    payload: IpcPayload<'project:update'>,
  ): Promise<IpcResult<'project:update'>>
  removeProject(
    payload: IpcPayload<'project:remove'>,
  ): Promise<IpcResult<'project:remove'>>
  listSessions(
    payload: IpcPayload<'session:list'>,
  ): Promise<IpcResult<'session:list'>>
  getSession(
    payload: IpcPayload<'session:get'>,
  ): Promise<IpcResult<'session:get'>>
  updateSession(
    payload: IpcPayload<'session:update'>,
  ): Promise<IpcResult<'session:update'>>
  archiveSession(
    payload: IpcPayload<'session:archive'>,
  ): Promise<IpcResult<'session:archive'>>
  forkSession(
    payload: IpcPayload<'session:fork'>,
  ): Promise<IpcResult<'session:fork'>>
  rewindSession(
    payload: IpcPayload<'session:rewind'>,
  ): Promise<IpcResult<'session:rewind'>>
  searchSessions(
    payload: IpcPayload<'session:search'>,
  ): Promise<IpcResult<'session:search'>>
  listMessages(
    payload: IpcPayload<'message:list'>,
  ): Promise<IpcResult<'message:list'>>
  searchMessages(
    payload: IpcPayload<'message:search'>,
  ): Promise<IpcResult<'message:search'>>
  listFileChanges(
    payload: IpcPayload<'file-change:list'>,
  ): Promise<IpcResult<'file-change:list'>>
  revertFileChange(
    payload: IpcPayload<'file-change:revert'>,
  ): Promise<IpcResult<'file-change:revert'>>
  chooseWorkspace(
    payload: IpcPayload<'workspace:choose'>,
  ): Promise<IpcResult<'workspace:choose'>>
  listWorkspaceDirectory(
    payload: IpcPayload<'workspace:list-directory'>,
  ): Promise<IpcResult<'workspace:list-directory'>>
  readWorkspaceFile(
    payload: IpcPayload<'workspace:read-file'>,
  ): Promise<IpcResult<'workspace:read-file'>>
  chooseWorkspaceContext(
    payload: IpcPayload<'workspace:choose-context'>,
  ): Promise<IpcResult<'workspace:choose-context'>>
  getProject(
    payload: IpcPayload<'project:get'>,
  ): Promise<IpcResult<'project:get'>>
  saveProject(
    payload: IpcPayload<'project:save'>,
  ): Promise<IpcResult<'project:save'>>
  detectProjectModules(
    payload: IpcPayload<'project:detect-modules'>,
  ): Promise<IpcResult<'project:detect-modules'>>
  getProjectBackendStatus(
    payload: IpcPayload<'project:backend-status'>,
  ): Promise<IpcResult<'project:backend-status'>>
  restartProjectBackend(
    payload: IpcPayload<'project:restart-backend'>,
  ): Promise<IpcResult<'project:restart-backend'>>
  updatePlanStatus(
    payload: IpcPayload<'plan:update-status'>,
  ): Promise<IpcResult<'plan:update-status'>>
  startRun(payload: IpcPayload<'run:start'>): Promise<IpcResult<'run:start'>>
  retryRun(payload: IpcPayload<'run:retry'>): Promise<IpcResult<'run:retry'>>
  interruptRun(
    payload: IpcPayload<'run:interrupt'>,
  ): Promise<IpcResult<'run:interrupt'>>
  interjectRun(
    payload: IpcPayload<'run:interject'>,
  ): Promise<IpcResult<'run:interject'>>
  decideApproval(
    payload: IpcPayload<'approval:decide'>,
  ): Promise<IpcResult<'approval:decide'>>
  sendTerminalInput(
    payload: IpcPayload<'terminal:input'>,
  ): Promise<IpcResult<'terminal:input'>>
  openTerminal(
    payload: IpcPayload<'terminal:open'>,
  ): Promise<IpcResult<'terminal:open'>>
  listTerminals(
    payload: IpcPayload<'terminal:list'>,
  ): Promise<IpcResult<'terminal:list'>>
  resizeTerminal(
    payload: IpcPayload<'terminal:resize'>,
  ): Promise<IpcResult<'terminal:resize'>>
  closeTerminal(
    payload: IpcPayload<'terminal:close'>,
  ): Promise<IpcResult<'terminal:close'>>
  getTerminalSnapshot(
    payload: IpcPayload<'terminal:snapshot'>,
  ): Promise<IpcResult<'terminal:snapshot'>>
  minimizeWindow(
    payload: IpcPayload<'window:minimize'>,
  ): Promise<IpcResult<'window:minimize'>>
  toggleMaximizeWindow(
    payload: IpcPayload<'window:toggle-maximize'>,
  ): Promise<IpcResult<'window:toggle-maximize'>>
  closeWindow(
    payload: IpcPayload<'window:close'>,
  ): Promise<IpcResult<'window:close'>>
  listSkills(
    payload: IpcPayload<'skills:list'>,
  ): Promise<IpcResult<'skills:list'>>
  installSkillFromUrl(
    payload: IpcPayload<'skills:installFromUrl'>,
  ): Promise<IpcResult<'skills:installFromUrl'>>
  chooseAndInstallSkill(
    payload: IpcPayload<'skills:chooseAndInstallFile'>,
  ): Promise<IpcResult<'skills:chooseAndInstallFile'>>
  refreshSkills(
    payload: IpcPayload<'skills:refresh'>,
  ): Promise<IpcResult<'skills:refresh'>>
  setSkillEnabled(
    payload: IpcPayload<'skills:setEnabled'>,
  ): Promise<IpcResult<'skills:setEnabled'>>
  listTraces(
    payload: IpcPayload<'trace:list'>,
  ): Promise<IpcResult<'trace:list'>>
  replayTrace(
    payload: IpcPayload<'trace:replay'>,
  ): Promise<IpcResult<'trace:replay'>>
  getSessionTranscriptPage(
    payload: IpcPayload<'trace:transcript-page'>,
  ): Promise<IpcResult<'trace:transcript-page'>>
  getSessionTranscriptRequestMessages(
    payload: IpcPayload<'trace:request-messages'>,
  ): Promise<IpcResult<'trace:request-messages'>>
  exportSessionTranscript(
    payload: IpcPayload<'trace:export-transcript'>,
  ): Promise<IpcResult<'trace:export-transcript'>>
  getTraceStats(
    payload: IpcPayload<'trace:stats'>,
  ): Promise<IpcResult<'trace:stats'>>
  openLogDirectory(
    payload: IpcPayload<'logs:open-directory'>,
  ): Promise<IpcResult<'logs:open-directory'>>
  clearClosedTraces(
    payload: IpcPayload<'logs:clear-closed'>,
  ): Promise<IpcResult<'logs:clear-closed'>>
  onAgentEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe
  onBackendNotification(
    listener: (event: BackendNotificationEnvelope) => void,
  ): Unsubscribe
  onTerminalEvent(listener: (event: TerminalEventEnvelope) => void): Unsubscribe
  onDomainStateEvent(
    listener: (event: DomainStateDelivery) => void,
  ): Unsubscribe
}

export const AGENT_API_KEYS = [
  'getConfig',
  'setConfig',
  'listMcpServers',
  'reloadMcpConfig',
  'trustAndEnableMcpServer',
  'disableMcpServer',
  'restartMcpServer',
  'listProviderModels',
  'getBootstrap',
  'listProjects',
  'addProject',
  'updateProjectRecord',
  'removeProject',
  'listSessions',
  'getSession',
  'updateSession',
  'archiveSession',
  'forkSession',
  'rewindSession',
  'searchSessions',
  'listMessages',
  'searchMessages',
  'listFileChanges',
  'revertFileChange',
  'chooseWorkspace',
  'listWorkspaceDirectory',
  'readWorkspaceFile',
  'chooseWorkspaceContext',
  'getProject',
  'saveProject',
  'detectProjectModules',
  'getProjectBackendStatus',
  'restartProjectBackend',
  'updatePlanStatus',
  'startRun',
  'retryRun',
  'interruptRun',
  'interjectRun',
  'decideApproval',
  'sendTerminalInput',
  'openTerminal',
  'listTerminals',
  'resizeTerminal',
  'closeTerminal',
  'getTerminalSnapshot',
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'listSkills',
  'installSkillFromUrl',
  'chooseAndInstallSkill',
  'refreshSkills',
  'setSkillEnabled',
  'listTraces',
  'replayTrace',
  'getSessionTranscriptPage',
  'getSessionTranscriptRequestMessages',
  'exportSessionTranscript',
  'getTraceStats',
  'openLogDirectory',
  'clearClosedTraces',
  'onAgentEvent',
  'onBackendNotification',
  'onTerminalEvent',
  'onDomainStateEvent',
] as const satisfies readonly (keyof AgentApi)[]
