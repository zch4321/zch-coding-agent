import type {
  AgentEventEnvelope,
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
  listProviderModels(
    payload: IpcPayload<'provider:list-models'>,
  ): Promise<IpcResult<'provider:list-models'>>
  getWorkbench(
    payload: IpcPayload<'workbench:get'>,
  ): Promise<IpcResult<'workbench:get'>>
  saveWorkbench(
    payload: IpcPayload<'workbench:save'>,
  ): Promise<IpcResult<'workbench:save'>>
  migrateWorkbenchV1(
    payload: IpcPayload<'workbench:migrate-v1'>,
  ): Promise<IpcResult<'workbench:migrate-v1'>>
  exportConversationMarkdown(
    payload: IpcPayload<'workbench:export-conversation'>,
  ): Promise<IpcResult<'workbench:export-conversation'>>
  importConversationMarkdown(
    payload: IpcPayload<'workbench:import-conversation'>,
  ): Promise<IpcResult<'workbench:import-conversation'>>
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
  createSession(
    payload: IpcPayload<'session:create'>,
  ): Promise<IpcResult<'session:create'>>
  listChanges(
    payload: IpcPayload<'changes:list'>,
  ): Promise<IpcResult<'changes:list'>>
  revertChange(
    payload: IpcPayload<'changes:revert'>,
  ): Promise<IpcResult<'changes:revert'>>
  closeSession(
    payload: IpcPayload<'session:close'>,
  ): Promise<IpcResult<'session:close'>>
  updateSessionMode(
    payload: IpcPayload<'session:update-mode'>,
  ): Promise<IpcResult<'session:update-mode'>>
  updatePlanStatus(
    payload: IpcPayload<'plan:update-status'>,
  ): Promise<IpcResult<'plan:update-status'>>
  startRun(payload: IpcPayload<'run:start'>): Promise<IpcResult<'run:start'>>
  interruptRun(
    payload: IpcPayload<'run:interrupt'>,
  ): Promise<IpcResult<'run:interrupt'>>
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
  getTraceStats(
    payload: IpcPayload<'trace:stats'>,
  ): Promise<IpcResult<'trace:stats'>>
  forkTrace(payload: IpcPayload<'trace:fork'>): Promise<IpcResult<'trace:fork'>>
  startTraceFork(
    payload: IpcPayload<'trace:start-fork'>,
  ): Promise<IpcResult<'trace:start-fork'>>
  openLogDirectory(
    payload: IpcPayload<'logs:open-directory'>,
  ): Promise<IpcResult<'logs:open-directory'>>
  clearClosedTraces(
    payload: IpcPayload<'logs:clear-closed'>,
  ): Promise<IpcResult<'logs:clear-closed'>>
  onAgentEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe
  onTerminalEvent(listener: (event: TerminalEventEnvelope) => void): Unsubscribe
}

export const AGENT_API_KEYS = [
  'getConfig',
  'setConfig',
  'listProviderModels',
  'getWorkbench',
  'saveWorkbench',
  'migrateWorkbenchV1',
  'exportConversationMarkdown',
  'importConversationMarkdown',
  'chooseWorkspace',
  'listWorkspaceDirectory',
  'readWorkspaceFile',
  'chooseWorkspaceContext',
  'createSession',
  'listChanges',
  'revertChange',
  'closeSession',
  'updateSessionMode',
  'updatePlanStatus',
  'startRun',
  'interruptRun',
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
  'getTraceStats',
  'forkTrace',
  'startTraceFork',
  'openLogDirectory',
  'clearClosedTraces',
  'onAgentEvent',
  'onTerminalEvent',
] as const satisfies readonly (keyof AgentApi)[]
