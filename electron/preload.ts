import { contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, IpcInvoke } from '../shared/agent-api'
import { AGENT_EVENT_CHANNEL, TERMINAL_EVENT_CHANNEL } from '../shared/channels'
import type {
  AgentEventEnvelope,
  TerminalEventEnvelope,
} from '../shared/ipc-contract'

const invoke: IpcInvoke = (channel, payload) =>
  ipcRenderer.invoke(channel, payload)

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

const api: AgentApi = {
  getConfig: (payload) => invoke('config:get', payload),
  setConfig: (payload) => invoke('config:set', payload),
  listProviderModels: (payload) => invoke('provider:list-models', payload),
  getWorkbench: (payload) => invoke('workbench:get', payload),
  saveWorkbench: (payload) => invoke('workbench:save', payload),
  migrateWorkbenchV1: (payload) => invoke('workbench:migrate-v1', payload),
  chooseWorkspace: (payload) => invoke('workspace:choose', payload),
  listWorkspaceDirectory: (payload) =>
    invoke('workspace:list-directory', payload),
  readWorkspaceFile: (payload) => invoke('workspace:read-file', payload),
  createSession: (payload) => invoke('session:create', payload),
  listChanges: (payload) => invoke('changes:list', payload),
  revertChange: (payload) => invoke('changes:revert', payload),
  closeSession: (payload) => invoke('session:close', payload),
  updateSessionMode: (payload) => invoke('session:update-mode', payload),
  startRun: (payload) => invoke('run:start', payload),
  interruptRun: (payload) => invoke('run:interrupt', payload),
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
  getTraceStats: (payload) => invoke('trace:stats', payload),
  forkTrace: (payload) => invoke('trace:fork', payload),
  startTraceFork: (payload) => invoke('trace:start-fork', payload),
  openLogDirectory: (payload) => invoke('logs:open-directory', payload),
  clearClosedTraces: (payload) => invoke('logs:clear-closed', payload),
  onAgentEvent: (listener) =>
    subscribe<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, listener),
  onTerminalEvent: (listener) =>
    subscribe<TerminalEventEnvelope>(TERMINAL_EVENT_CHANNEL, listener),
}
const agentApi = Object.freeze(api)

contextBridge.exposeInMainWorld('agentApi', agentApi)
