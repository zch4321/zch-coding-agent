import type { RunContext } from '../../shared/context'
import type { ContextAttachmentChip } from '../../shared/context'
import type { MessageVisibility } from '../../shared/message'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { SkillsManager } from '../skills/manager'
import { prepareRunContext } from './context-attachments'
import { selectedContextContent } from './prompt-harness'
import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import { resolveSlashCommand } from './slash-commands'
import type { ActiveRun, AgentEventDraft, SessionState } from './session-types'
import { resolveSwarmAvailability } from './session-swarm-availability'
import type { AttachmentService } from '../attachments/service'
import { DomainError } from '../common/domain-error'

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
  readonly #attachments: AttachmentService | undefined
  readonly #configStore: ConfigStore
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #swarmHostEnabled: boolean

  constructor(options: {
    attachments?: AttachmentService
    configStore: ConfigStore
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
    swarmHostEnabled?: boolean
  }) {
    this.#attachments = options.attachments
    this.#configStore = options.configStore
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#swarmHostEnabled = options.swarmHostEnabled ?? false
  }

  /** Checks image capability and snapshot integrity before compaction or durable input mutations. */
  async preflight(
    session: SessionState,
    run: ActiveRun,
    userMessage?: string,
  ): Promise<void> {
    if (
      userMessage !== undefined &&
      !userMessage.trim() &&
      !run.attachmentIds?.length
    )
      throw new DomainError(
        'PRECONDITION_FAILED',
        'Message must contain text or attachments',
      )
    if (run.attachmentIds?.length) {
      if (!this.#attachments || !session.sessionTemp.projectId)
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Attachment storage is unavailable',
        )
      if (/^\/compact(?:\s|$)/iu.test(userMessage?.trimStart() ?? ''))
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Send attachments as a message before compacting',
        )
      run.inputAttachments = await this.#attachments.preflight(
        session.sessionTemp.projectId,
        run.attachmentIds,
      )
    }
    const containsImages =
      run.inputAttachments?.some((item) => item.kind === 'image') ||
      session.history.some(
        (record) =>
          record.inHistory &&
          record.parts.some((part) => part.type === 'image'),
      )
    if (
      containsImages &&
      run.routes?.main.modelProfile.imageInput === 'unsupported'
    )
      throw new DomainError(
        'PRECONDITION_FAILED',
        'Selected model does not support image input',
      )
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
    if (command.swarmGoal) {
      const swarm = resolveSwarmAvailability({
        hostEnabled: this.#swarmHostEnabled,
        runSubagentsEnabled: run.subagentsEnabled,
        config,
        requestedGoal: command.swarmGoal,
      })
      run.swarmToolConfig = swarm.toolConfig
      if (swarm.unavailableReason) {
        throw new Error(swarm.unavailableReason)
      }
    }
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
