import { getActiveProviderConfig } from '../../shared/config'
import type { RunStatus } from '../../shared/agent-events'
import type { CallId } from '../../shared/ids'
import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { ProviderEvent, ProviderMessage } from '../providers/provider'
import { normalizeLlmUsage } from '../providers/usage'
import type { SkillsManager } from '../skills/manager'
import { ContextBudgetError } from '../tools/context-budget'
import type { ToolRegistry } from '../tools/tool-registry'
import { id, ipcFault, toJsonValue } from './session-common'
import { createConfiguredProvider } from './session-provider-turn'
import { modelPromptBudget } from './session-run-utils'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import {
  appendInitialPromptHarness,
  orchestrationRequestContent,
  promptResources,
  selectPromptMessages,
} from './prompt-harness'
import { resolveSlashCommand } from './slash-commands'

export class SessionCompactCoordinator {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #skillsManager: SkillsManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #setRunStatus: (
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ) => void

  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    skillsManager?: SkillsManager
    promptRegistry?: PromptRegistry
    providerFactory: SessionManagerOptions['providerFactory']
    fetchImpl: SessionManagerOptions['fetchImpl']
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
    setRunStatus: (
      session: SessionState,
      run: ActiveRun,
      status: RunStatus,
      error?: unknown,
    ) => void
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#skillsManager = options.skillsManager
    this.#promptRegistry = options.promptRegistry
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
  }

  async maybeAutoCompactBeforeProviderCall(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    const preserveFromIndex = run.currentTurnStartIndex

    if (
      preserveFromIndex === undefined ||
      preserveFromIndex <= 0 ||
      preserveFromIndex > session.history.length
    ) {
      return
    }

    const config = this.#configStore.getPublicConfig()
    const tools = this.#toolRegistry.providerDefinitions()
    const promptBudgetTokens = modelPromptBudget(config, tools)
    const triggerTokens = Math.floor(
      (promptBudgetTokens * config.limits.autoCompactTriggerPercent) / 100,
    )
    let shouldCompact: boolean

    try {
      const selection = selectPromptMessages({
        state: session,
        tools,
        maxPromptTokens: promptBudgetTokens,
        estimation: config.limits.tokenEstimation,
      })
      shouldCompact =
        selection.promptBuild.estimatedTokens >= triggerTokens ||
        selection.promptBuild.omittedHistoryMessages > 0
    } catch (error) {
      if (!(error instanceof ContextBudgetError)) {
        throw error
      }

      shouldCompact = true
    }

    if (!shouldCompact) {
      return
    }

    const messagesToSummarize = this.#messagesForCompact(
      session,
      0,
      preserveFromIndex,
    )

    if (messagesToSummarize.length === 0) {
      return
    }

    const prompt = this.#orchestratorMessages.prompt('compact')
    const text = [
      prompt.text,
      '',
      `Automatic compact trigger: estimated prompt reached ${config.limits.autoCompactTriggerPercent}% of the current prompt budget.`,
      'Summarize only the older history before the current user turn; the current turn will remain available verbatim after compaction.',
    ].join('\n')

    await this.#orchestratorMessages.emit(session, run, {
      kind: 'compact-auto',
      text,
      resource: prompt.resource,
      injectIntoHistory: false,
    })

    const summary = await this.#createCompactSummary(
      session,
      run,
      text,
      messagesToSummarize,
      false,
    )

    await this.#rewriteHistoryAfterCompact(session, run, summary, {
      preserveFromIndex,
      source: 'auto:context-budget',
    })
  }

  async runCompactCommand(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
  ): Promise<void> {
    const config = this.#configStore.getPublicConfig()
    const command = resolveSlashCommand({
      message: userMessage,
      config,
      skillsManager: this.#skillsManager,
      promptRegistry: this.#promptRegistry,
    })
    const compactPrompt = command.orchestratorMessage

    if (!compactPrompt || compactPrompt.kind !== 'compact') {
      throw new Error('Invalid compact command')
    }

    await session.logger.write({
      type: 'user.message',
      sessionId: session.sessionId,
      runId: run.runId,
      text: command.visibleMessage,
    })
    await session.logger.write({
      type: 'run.start',
      sessionId: session.sessionId,
      runId: run.runId,
    })
    await this.#orchestratorMessages.emit(session, run, {
      ...compactPrompt,
      injectIntoHistory: false,
    })

    const summary = await this.#createCompactSummary(
      session,
      run,
      compactPrompt.text,
      this.#messagesForCompact(session, 0, session.history.length),
      true,
    )

    await this.#rewriteHistoryAfterCompact(session, run, summary, {
      preserveFromIndex: session.history.length,
      source: 'slash:/compact',
    })

    this.#emit(session, {
      type: 'assistant.message.completed',
      sessionId: session.sessionId,
      runId: run.runId,
      text: summary,
    })
    await session.logger.write({
      type: 'agent.message',
      sessionId: session.sessionId,
      runId: run.runId,
      text: summary,
    })
  }

  #messagesForCompact(
    session: SessionState,
    startIndex: number,
    endIndex: number,
  ): ProviderMessage[] {
    const excludedKinds = new Set([
      'base_instructions',
      'runtime_policy_and_context',
      'assistant_preferences',
      'agents',
    ])
    const excludedIndexes = new Set(
      session.promptLedger
        .filter((entry) => excludedKinds.has(entry.kind))
        .map((entry) => entry.messageIndex),
    )

    return session.history
      .slice(startIndex, endIndex)
      .filter((_message, index) => !excludedIndexes.has(startIndex + index))
  }

  async #createCompactSummary(
    session: SessionState,
    run: ActiveRun,
    promptText: string,
    messagesToSummarize: ProviderMessage[],
    emitText: boolean,
  ): Promise<string> {
    const config = this.#configStore.getPublicConfig()
    const providerConfig = getActiveProviderConfig(config)
    const apiKey = await this.#configStore.getProviderApiKey(providerConfig.id)

    if (!apiKey) {
      ipcFault(
        'PRECONDITION_FAILED',
        `${providerConfig.label} credential is not available`,
      )
    }

    const provider =
      this.#providerFactory?.({ config, apiKey }) ??
      createConfiguredProvider(config, providerConfig, apiKey, this.#fetchImpl)
    const callId = id<CallId>('llm')
    const messages: ProviderMessage[] = [
      ...structuredClone(messagesToSummarize),
      {
        role: 'user',
        content: orchestrationRequestContent('compact', promptText),
      },
    ]
    let text = ''
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined

    this.#setRunStatus(session, run, 'calling_llm')

    for await (const event of provider.streamChat({
      messages,
      tools: [],
      signal: run.controller.signal,
      onRequest: async (snapshot) => {
        await session.logger.write({
          type: 'llm.request',
          sessionId: session.sessionId,
          runId: run.runId,
          callId,
          normalizedMessages: snapshot.normalizedMessages,
          providerRequest: snapshot.providerRequest,
          requestBytes: snapshot.requestBytes,
          prefixHash: snapshot.prefixHash,
          prefixFingerprints: snapshot.prefixFingerprints,
          promptResources: promptResources(session),
        })
      },
    })) {
      if (event.type === 'text.delta') {
        text += event.delta
        if (emitText) {
          this.#emit(session, {
            type: 'assistant.text.delta',
            sessionId: session.sessionId,
            runId: run.runId,
            delta: event.delta,
          })
        }
      } else if (event.type === 'completed') {
        completed = event
      }
    }

    if (!completed) {
      throw new Error(
        'Compact summary provider stream ended without completion',
      )
    }

    if (completed.toolCalls.length > 0) {
      throw new Error('Compact summary provider returned tool calls')
    }

    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId,
      rawResponse: completed.rawResponse,
      normalizedTurn: toJsonValue(completed.turn),
      providerState: completed.providerState,
      usage: completed.usage,
      timing: completed.timing,
    })

    const usage = normalizeLlmUsage({
      scope: 'compression',
      config,
      provider: providerConfig,
      raw: completed.usage,
    })

    if (usage) {
      await session.logger.write({
        type: 'llm.usage',
        sessionId: session.sessionId,
        runId: run.runId,
        callId,
        usage,
      })
      this.#emit(session, {
        type: 'llm.usage',
        sessionId: session.sessionId,
        runId: run.runId,
        callId,
        usage,
      })
    }

    return (
      text ||
      (typeof completed.turn.content === 'string' ? completed.turn.content : '')
    ).trim()
  }

  async #rewriteHistoryAfterCompact(
    session: SessionState,
    run: ActiveRun,
    summary: string,
    options: {
      preserveFromIndex: number
      source: string
    },
  ): Promise<void> {
    if (!summary) {
      throw new Error('Compact summary was empty')
    }

    const previousHistory = structuredClone(session.history)
    const previousLedger = structuredClone(session.promptLedger)
    const preserveFromIndex = Math.min(
      Math.max(options.preserveFromIndex, 0),
      previousHistory.length,
    )
    const preservedMessages = previousHistory.slice(preserveFromIndex)
    const preservedLedger = previousLedger.filter(
      (entry) => entry.messageIndex >= preserveFromIndex,
    )

    session.history = []
    session.promptLedger = []
    session.nextPromptSeq = 1
    delete session.lastRuntimeContextHash
    delete session.lastAgentsContextHash

    await appendInitialPromptHarness(session, {
      workspace: session.workspace,
      mode: session.mode,
      config: this.#configStore.getPublicConfig(),
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      compactHistory: {
        summary,
        source: options.source,
      },
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      signal: run.controller.signal,
    })

    const rebasedStartIndex = session.history.length
    session.history.push(...preservedMessages)
    run.currentTurnStartIndex =
      preservedMessages.length > 0 ? rebasedStartIndex : undefined

    for (const entry of preservedLedger) {
      session.promptLedger.push({
        ...entry,
        seq: session.nextPromptSeq,
        messageIndex:
          rebasedStartIndex + entry.messageIndex - preserveFromIndex,
      })
      session.nextPromptSeq += 1
    }
  }
}
