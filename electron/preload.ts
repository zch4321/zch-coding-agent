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
  chooseWorkspace: (payload) => invoke('workspace:choose', payload),
  createSession: (payload) => invoke('session:create', payload),
  closeSession: (payload) => invoke('session:close', payload),
  startRun: (payload) => invoke('run:start', payload),
  interruptRun: (payload) => invoke('run:interrupt', payload),
  decideApproval: (payload) => invoke('approval:decide', payload),
  sendTerminalInput: (payload) => invoke('terminal:input', payload),
  listSkills: (payload) => invoke('skills:list', payload),
  installSkillFromUrl: (payload) => invoke('skills:installFromUrl', payload),
  chooseAndInstallSkill: (payload) =>
    invoke('skills:chooseAndInstallFile', payload),
  refreshSkills: (payload) => invoke('skills:refresh', payload),
  setSkillEnabled: (payload) => invoke('skills:setEnabled', payload),
  onAgentEvent: (listener) =>
    subscribe<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, listener),
  onTerminalEvent: (listener) =>
    subscribe<TerminalEventEnvelope>(TERMINAL_EVENT_CHANNEL, listener),
}
const agentApi = Object.freeze(api)

contextBridge.exposeInMainWorld('agentApi', agentApi)
