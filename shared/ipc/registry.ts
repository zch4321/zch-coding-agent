import type { Static } from '@sinclair/typebox'
import { BACKGROUND_IPC_CONTRACTS } from './background'
import { AGENT_EXECUTION_IPC_CONTRACTS, PLAN_IPC_CONTRACTS } from './agents'
import {
  APP_BOOTSTRAP_IPC_CONTRACTS,
  WINDOW_IPC_CONTRACTS,
} from './application'
import {
  CONFIGURATION_IPC_CONTRACTS,
  PROVIDER_IPC_CONTRACTS,
} from './configuration'
import { DIAGNOSTICS_IPC_CONTRACTS } from './diagnostics'
import { MCP_IPC_CONTRACTS, SKILLS_IPC_CONTRACTS } from './integrations'
import {
  PROJECT_STATE_IPC_CONTRACTS,
  WORKSPACE_IPC_CONTRACTS,
} from './projects'
import { RUN_IPC_CONTRACTS } from './runs'
import { SESSION_IPC_CONTRACTS } from './sessions'
import { TERMINAL_IPC_CONTRACTS } from './terminals'

export const IPC_CONTRACTS = {
  ...BACKGROUND_IPC_CONTRACTS,
  ...CONFIGURATION_IPC_CONTRACTS,
  ...MCP_IPC_CONTRACTS,
  ...PROVIDER_IPC_CONTRACTS,
  ...APP_BOOTSTRAP_IPC_CONTRACTS,
  ...PROJECT_STATE_IPC_CONTRACTS,
  ...SESSION_IPC_CONTRACTS,
  ...AGENT_EXECUTION_IPC_CONTRACTS,
  ...WORKSPACE_IPC_CONTRACTS,
  ...PLAN_IPC_CONTRACTS,
  ...RUN_IPC_CONTRACTS,
  ...TERMINAL_IPC_CONTRACTS,
  ...WINDOW_IPC_CONTRACTS,
  ...SKILLS_IPC_CONTRACTS,
  ...DIAGNOSTICS_IPC_CONTRACTS,
} as const

export type IpcChannel = keyof typeof IPC_CONTRACTS
export type IpcPayload<Channel extends IpcChannel> = Static<
  (typeof IPC_CONTRACTS)[Channel]['payload']
>
export type IpcResult<Channel extends IpcChannel> = Static<
  (typeof IPC_CONTRACTS)[Channel]['result']
>
