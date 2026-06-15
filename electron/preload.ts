import { contextBridge } from 'electron'
import type { AgentApi } from '../shared/agent-api'

const agentApi: AgentApi = Object.freeze({})

contextBridge.exposeInMainWorld('agentApi', agentApi)
