import type { RunContext } from '../../shared/context'
import type { ContextAttachmentChip } from '../../shared/context'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
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
import { resolveSessionToolCatalog } from './session-tool-catalog'

export interface PreparedUserTurn {
  visibleMessage: string
  providerMessage: string
  attachments: ContextAttachmentChip[]
  appMessages: Array<{
    kind: 'selected_context' | 'orchestrator' | 'interjection'
    content: string
    source: string
  }>
}

/** Prepares user messages, slash commands, prompt layers, and run context for a provider turn. */
export class SessionUserTurnPreparer {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #projectMetadata: ProjectMetadataStore | undefined
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #getWorkspaceConcurrency: (
    session: SessionState,
  ) => WorkspaceConcurrencyContext

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    projectMetadata?: ProjectMetadataStore
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
    getWorkspaceConcurrency?: (
      session: SessionState,
    ) => WorkspaceConcurrencyContext
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#projectMetadata = options.projectMetadata
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#getWorkspaceConcurrency =
      options.getWorkspaceConcurrency ?? (() => ({ status: 'available' }))
  }

  /** Appends the user turn, selected context, and harness prompts before provider execution. */
  async prepare(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
    context?: RunContext,
  ): Promise<PreparedUserTurn> {
    const config = this.#configStore.getPublicConfig()
    const toolCatalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      projectMetadata: this.#projectMetadata,
      workspace: session.workspace,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      gitToolsEnabled: session.gitToolsEnabled,
      readOnlyWorkspace: session.readOnlyWorkspace,
    })
    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      reason: 'run_started',
      workspaceConcurrency: this.#getWorkspaceConcurrency(session),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
      readOnlyWorkspace: session.readOnlyWorkspace,
    })
    await appendAgentsContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
      readOnlyWorkspace: session.readOnlyWorkspace,
    })
    const command = resolveSlashCommand({
      message: userMessage,
      config,
      skillsManager: this.#skillsManager,
      promptRegistry: this.#promptRegistry,
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
