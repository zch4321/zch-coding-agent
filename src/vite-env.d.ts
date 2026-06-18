/// <reference types="vite/client" />

import type { AgentApi } from '../shared/agent-api'

declare global {
  interface Window {
    readonly agentApi?: AgentApi
  }
}

export {}
