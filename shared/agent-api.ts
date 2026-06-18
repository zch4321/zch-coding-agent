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
  chooseWorkspace(
    payload: IpcPayload<'workspace:choose'>,
  ): Promise<IpcResult<'workspace:choose'>>
  listWorkspaceDirectory(
    payload: IpcPayload<'workspace:list-directory'>,
  ): Promise<IpcResult<'workspace:list-directory'>>
  readWorkspaceFile(
    payload: IpcPayload<'workspace:read-file'>,
  ): Promise<IpcResult<'workspace:read-file'>>
  createSession(
    payload: IpcPayload<'session:create'>,
  ): Promise<IpcResult<'session:create'>>
  closeSession(
    payload: IpcPayload<'session:close'>,
  ): Promise<IpcResult<'session:close'>>
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
  onAgentEvent(listener: (event: AgentEventEnvelope) => void): Unsubscribe
  onTerminalEvent(listener: (event: TerminalEventEnvelope) => void): Unsubscribe
}

export const AGENT_API_KEYS = [
  'getConfig',
  'setConfig',
  'chooseWorkspace',
  'listWorkspaceDirectory',
  'readWorkspaceFile',
  'createSession',
  'closeSession',
  'startRun',
  'interruptRun',
  'decideApproval',
  'sendTerminalInput',
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'listSkills',
  'installSkillFromUrl',
  'chooseAndInstallSkill',
  'refreshSkills',
  'setSkillEnabled',
  'onAgentEvent',
  'onTerminalEvent',
] as const satisfies readonly (keyof AgentApi)[]
