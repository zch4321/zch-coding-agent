import type { ConfigStore } from '../config/store'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import {
  appendPromptLayer,
  orchestrationRequestContent,
} from './prompt-harness'
import type { ActiveRun, AgentEventDraft, SessionState } from './session-types'

export type OrchestrationPromptKind =
  | 'goalContinue'
  | 'planContinue'
  | 'planWarning'
  | 'compact'

export interface ResolvedOrchestrationPrompt {
  text: string
  resource?: PromptResourceSummary
}

export class SessionOrchestratorMessages {
  readonly #configStore: ConfigStore
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void

  constructor(options: {
    configStore: ConfigStore
    promptRegistry?: PromptRegistry
    emit: (session: SessionState, event: AgentEventDraft) => void
  }) {
    this.#configStore = options.configStore
    this.#promptRegistry = options.promptRegistry
    this.#emit = options.emit
  }

  prompt(kind: OrchestrationPromptKind): ResolvedOrchestrationPrompt {
    const config = this.#configStore.getPublicConfig()
    const resolved = this.#promptRegistry?.orchestrationPrompt(
      kind,
      config.assistant.language,
    )

    if (resolved) {
      return { text: resolved.content, resource: resolved.resource }
    }

    return {
      text: `Continue orchestration step: ${kind}`,
    }
  }

  async emit(
    session: SessionState,
    run: ActiveRun,
    input: {
      kind: string
      text: string
      resource?: PromptResourceSummary
      injectIntoHistory: boolean
    },
  ): Promise<void> {
    this.#emit(session, {
      type: 'orchestrator.message',
      sessionId: session.sessionId,
      runId: run.runId,
      kind: input.kind,
      text: input.text,
      promptId: input.resource?.id,
      promptHash: input.resource?.sha256,
    })

    await session.logger.write({
      type: 'orchestrator.message',
      sessionId: session.sessionId,
      runId: run.runId,
      kind: input.kind,
      text: input.text,
      promptId: input.resource?.id,
      promptHash: input.resource?.sha256,
    })

    if (input.injectIntoHistory) {
      appendPromptLayer(session, {
        kind: 'orchestration_request',
        role: 'user',
        content: orchestrationRequestContent(input.kind, input.text),
        source: `orchestration.${input.kind}`,
        trusted: false,
        editable: false,
        config: this.#configStore.getPublicConfig(),
      })
    }
  }
}
