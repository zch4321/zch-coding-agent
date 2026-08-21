import type { ConfigStore } from '../config/store'
import type { SkillsManager } from '../skills/manager'
import { registerFetchTools } from '../tools/fetch-tools'
import { registerFileTools } from '../tools/file-tools'
import {
  registerGitReadOnlyTools,
  registerGitWriteTools,
} from '../tools/git-tools'
import { registerProcessTools } from '../tools/process-tools'
import { registerReadOnlyTools } from '../tools/readonly-tools'
import { registerSkillTools } from '../tools/skill-tools'
import { registerTerminalTools } from '../tools/terminal-tools'
import { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import { registerWebSearchTools } from '../tools/web-search-tools'
import { registerOrchestrationTools } from './orchestration-tools'
import type { SessionTerminalController } from './session-terminals'
import type { AgentEventDraft, SessionState } from './session-types'
import type { SessionId } from '../../shared/ids'
import type { McpManager } from '../mcp/mcp-manager'
import { registerMcpTools, type McpToolGateway } from '../tools/mcp-tools'
import type { SubagentExecutionPort } from '../subagent/contracts'
import { registerSubagentTools } from '../tools/subagent-tools'
import type { SwarmExecutionPort } from '../swarm/contracts'
import { registerSwarmTools } from '../tools/swarm-tools'
import { registerTodoTools } from './todo-tools'

export interface SessionTooling {
  toolRegistry: ToolRegistry
  toolExecutor: ToolExecutor
  mcpGateway?: McpToolGateway
}

/** Builds the Session tool bundle from registry, terminal, skills, and runtime services. */
export function createSessionTooling(options: {
  configStore: ConfigStore
  terminals: SessionTerminalController
  skillsManager?: SkillsManager
  mcpManager?: McpManager
  subagentExecution?: SubagentExecutionPort
  swarmExecution?: SwarmExecutionPort
  getSession: (sessionId: SessionId) => SessionState | undefined
  emit: (session: SessionState, event: AgentEventDraft) => void
}): SessionTooling {
  const toolRegistry = new ToolRegistry()

  registerReadOnlyTools(
    toolRegistry,
    () => options.configStore.getPublicConfig().limits,
  )
  registerFileTools(
    toolRegistry,
    () => options.configStore.getPublicConfig().limits,
  )
  registerProcessTools(toolRegistry, () =>
    options.configStore.getPublicConfig(),
  )
  registerGitReadOnlyTools(toolRegistry, () =>
    options.configStore.getPublicConfig(),
  )
  registerGitWriteTools(toolRegistry, () =>
    options.configStore.getPublicConfig(),
  )
  registerFetchTools(toolRegistry, () => options.configStore.getPublicConfig())
  registerWebSearchTools(toolRegistry, options.configStore)
  registerTerminalTools(
    toolRegistry,
    options.terminals.pool,
    () => options.configStore.getPublicConfig().limits.maxToolOutputBytes,
  )
  if (options.skillsManager) {
    registerSkillTools(toolRegistry, options.skillsManager)
  }
  registerOrchestrationTools(toolRegistry, {
    getSession: options.getSession,
    emit: options.emit,
  })
  registerTodoTools(toolRegistry, {
    getSession: options.getSession,
    emit: options.emit,
  })
  if (options.subagentExecution) {
    registerSubagentTools(toolRegistry, options.subagentExecution)
  }
  if (options.swarmExecution) {
    registerSwarmTools(toolRegistry, options.swarmExecution)
  }

  const mcpGateway = options.mcpManager
    ? registerMcpTools(toolRegistry, {
        manager: options.mcpManager,
        configStore: options.configStore,
        getSession: options.getSession,
      })
    : undefined

  return {
    toolRegistry,
    toolExecutor: new ToolExecutor(toolRegistry),
    mcpGateway,
  }
}
