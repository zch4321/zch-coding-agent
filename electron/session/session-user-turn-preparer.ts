import type { RunContext } from '../../shared/context'
import type { ContextAttachmentChip } from '../../shared/context'
import type { MessageVisibility } from '../../shared/message'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { SkillsManager } from '../skills/manager'
import type { ToolRegistry } from '../tools/tool-registry'
import { prepareRunContext } from './context-attachments'
import {
  appendAgentsContextIfChanged,
  appendRuntimeContextIfChanged,
  selectedContextContent,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'
import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import { resolveSlashCommand } from './slash-commands'
import type { ActiveRun, AgentEventDraft, SessionState } from './session-types'
import { resolveSwarmAvailability } from './session-swarm-availability'
import { resolveSessionToolCatalog } from './session-tool-catalog'

export interface PreparedUserTurn {
  visibleMessage: string
  providerMessage: string
  attachments: ContextAttachmentChip[]
  appMessages: Array<{
    kind: 'selected_context' | 'orchestrator' | 'interjection'
    content: string
    source: string
    visibility?: Exclude<MessageVisibility, 'superseded'>
  }>
}

/** Prepares user messages, slash commands, prompt layers, and run context for a provider turn. */
export class SessionUserTurnPreparer {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #getWorkspaceConcurrency: (
    session: SessionState,
  ) => WorkspaceConcurrencyContext
  readonly #swarmHostEnabled: boolean

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
    getWorkspaceConcurrency?: (
      session: SessionState,
    ) => WorkspaceConcurrencyContext
    swarmHostEnabled?: boolean
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
    this.#swarmHostEnabled = options.swarmHostEnabled ?? false
  }

  /** Appends the user turn, selected context, and harness prompts before provider execution. */
  async prepare(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
    context?: RunContext,
  ): Promise<PreparedUserTurn> {
    const config = this.#configStore.getPublicConfig()
    const command = resolveSlashCommand({
      message: userMessage,
      config,
      skillsManager: this.#skillsManager,
      promptRegistry: this.#promptRegistry,
    })
    const swarm = resolveSwarmAvailability({
      hostEnabled: this.#swarmHostEnabled,
      runSubagentsEnabled: run.subagentsEnabled,
      config,
      requestedGoal: command.swarmGoal,
    })
    run.swarmToolConfig = swarm.toolConfig
    if (command.swarmGoal && swarm.unavailableReason) {
      throw new Error(swarm.unavailableReason)
    }
    const toolCatalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      swarmMaxAgents: run.swarmToolConfig?.maxAgentsPerJob,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      reason: 'run_started',
      workspaceConcurrency: this.#getWorkspaceConcurrency(session),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    })
    await appendAgentsContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    })
    if (command.goal) {
      session.goal = command.goal
      this.#emit(session, {
        type: 'goal.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        goal: structuredClone(command.goal),
      })
    }

    if (command.orchestratorMessage) {
      await this.#orchestratorMessages.emit(session, run, {
        ...command.orchestratorMessage,
        injectIntoHistory: false,
      })
    }

    const preparedContext = await prepareRunContext({
      workspace: session.workspace,
      attachments: context?.attachments ?? [],
      config,
      signal: run.controller.signal,
    })

    const appMessages: PreparedUserTurn['appMessages'] = []

    for (const message of command.providerContextMessages ?? []) {
      appMessages.push(message)
    }

    if (preparedContext.providerContent) {
      appMessages.push({
        kind: 'selected_context',
        content: selectedContextContent(
          preparedContext.providerContent,
          'run_context',
        ),
        source: 'run_context.attachments',
      })
    }

    return {
      visibleMessage: command.visibleMessage,
      providerMessage: command.providerMessage,
      attachments: preparedContext.chips,
      appMessages,
    }
  }
}
