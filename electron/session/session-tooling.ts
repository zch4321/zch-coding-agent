import type { ConfigStore } from '../config/store'
import type { SkillsManager } from '../skills/manager'
import { registerFetchTools } from '../tools/fetch-tools'
import { registerCodeIntelligenceTools } from '../tools/code-intelligence-tools'
import { registerFileTools } from '../tools/file-tools'
import {
  registerGitReadOnlyTools,
  registerGitWriteTools,
} from '../tools/git-tools'
import { registerProcessTools } from '../tools/process-tools'
import { registerProjectTools } from '../tools/project-tools'
import { registerReadOnlyTools } from '../tools/readonly-tools'
import { registerSkillTools } from '../tools/skill-tools'
import { registerTerminalTools } from '../tools/terminal-tools'
import { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import { registerWebSearchTools } from '../tools/web-search-tools'
import { registerOrchestrationTools } from './orchestration-tools'
import type { SessionTerminalController } from './session-terminals'
import type { AgentEventDraft, SessionState } from './session-types'
import type { SessionId } from '../../shared/ids'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'

export interface SessionTooling {
  toolRegistry: ToolRegistry
  toolExecutor: ToolExecutor
}

export function createSessionTooling(options: {
  configStore: ConfigStore
  terminals: SessionTerminalController
  skillsManager?: SkillsManager
  projectMetadata?: ProjectMetadataStore
  codeBackends?: CodeBackendManager
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
  if (options.projectMetadata) {
    registerProjectTools(toolRegistry, options.projectMetadata)
  }
  if (options.codeBackends) {
    registerCodeIntelligenceTools(toolRegistry, options.codeBackends)
  }
  registerOrchestrationTools(toolRegistry, {
    getSession: options.getSession,
    emit: options.emit,
  })

  return {
    toolRegistry,
    toolExecutor: new ToolExecutor(toolRegistry),
  }
}
