import path from 'node:path'
import {
  getActiveProviderConfig,
  getProviderConfig,
  type PermissionMode,
} from '../../shared/config'
import type { RunStatus } from '../../shared/agent-events'
import type {
  CallId,
  EventId,
  RunId,
  SessionId,
  TerminalId,
} from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { RunContext } from '../../shared/context'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import type { PlanState, PlanStatus } from '../../shared/orchestration'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import { JsonlTraceLogger, NullTraceLogger } from '../logging/logger'
import { cleanupTraces } from '../logging/cleanup'
import type { PluginEventBus } from '../plugins/event-bus'
import { PathGuard } from '../safety/path-guard'
import type { ProviderEvent, ProviderMessage } from '../providers/provider'
import { ContextBudgetError } from '../tools/context-budget'
import { registerReadOnlyTools } from '../tools/readonly-tools'
import { registerFileTools } from '../tools/file-tools'
import { registerFetchTools } from '../tools/fetch-tools'
import {
  registerGitReadOnlyTools,
  registerGitWriteTools,
} from '../tools/git-tools'
import { registerProcessTools } from '../tools/process-tools'
import { registerWebSearchTools } from '../tools/web-search-tools'
import {
  PermissionPipeline,
  type RememberApprovalInput,
} from '../permission/permission-pipeline'
import type { ChangeHistoryStore } from './change-history'
import { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import { registerTerminalTools } from '../tools/terminal-tools'
import type { SkillsManager } from '../skills/manager'
import { registerSkillTools } from '../tools/skill-tools'
import {
  delay,
  finalStatusFromError,
  modelPromptBudget,
} from './session-run-utils'
import { id, ipcFault, toJsonValue } from './session-common'
import type {
  ActiveRun,
  AgentEventDraft,
  RunInterjection,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import { SessionEventEmitter } from './session-events'
import { SessionTerminalController } from './session-terminals'
import { SessionApprovalCoordinator } from '../permission/session-approval'
import { SessionContextGate } from './session-context-gate'
import {
  createConfiguredProvider,
  SessionProviderTurnRunner,
} from './session-provider-turn'
import { SessionToolRunner } from './session-tool-runner'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import { prepareRunContext } from './context-attachments'
import { resolveSlashCommand } from './slash-commands'
import { registerOrchestrationTools } from './orchestration-tools'
import { normalizeLlmUsage } from '../providers/usage'
import {
  appendAgentsContextIfChanged,
  appendInitialPromptHarness,
  appendPromptLayer,
  appendRuntimeContextIfChanged,
  orchestrationRequestContent,
  promptResources,
  selectedContextContent,
  selectPromptMessages,
} from './prompt-harness'

const RUN_CANCEL_GRACE_MS = 2_000
const MAX_GOAL_CONTINUATIONS = 8

const INTERJECTION_RULE_NOTE =
  'Messages tagged as <live_user_interjection> are real user messages received while the current run was already in progress. They are not tool output. Treat them as the latest user instruction for the next reasoning step, while respecting system, developer, runtime, repository, and tool-safety instructions.'

function isCompactSlashCommand(message: string): boolean {
  return /^\/compact(?:\s|$)/iu.test(message.trimStart())
}

function liveUserInterjectionContent(content: string): string {
  return [
    '<live_user_interjection>',
    content,
    '</live_user_interjection>',
    '',
    INTERJECTION_RULE_NOTE,
  ].join('\n')
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

export class SessionManager {
  readonly #configStore: ConfigStore
  readonly #traceDirectory: string
  readonly #getWebContents: SessionManagerOptions['getWebContents']
  readonly #pluginBus: PluginEventBus | undefined
  readonly #skillsManager: SkillsManager | undefined
  readonly #changeHistory: ChangeHistoryStore | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #sessions = new Map<SessionId, SessionState>()
  readonly #toolRegistry = new ToolRegistry()
  readonly #toolExecutor: ToolExecutor
  readonly #events: SessionEventEmitter
  readonly #terminals: SessionTerminalController
  readonly #approvals: SessionApprovalCoordinator
  readonly #contextGate: SessionContextGate
  readonly #providerTurns: SessionProviderTurnRunner
  readonly #toolRunner: SessionToolRunner
  readonly #permissionPipeline = new PermissionPipeline()

  constructor(options: SessionManagerOptions) {
    this.#configStore = options.configStore
    this.#traceDirectory = options.traceDirectory
    this.#getWebContents = options.getWebContents
    this.#pluginBus = options.pluginBus
    this.#skillsManager = options.skillsManager
    this.#changeHistory = options.changeHistory
    this.#promptRegistry = options.promptRegistry
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#autoApproverFactory = options.autoApproverFactory
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.#events = new SessionEventEmitter({
      getWebContents: this.#getWebContents,
      getSession: (sessionId) => this.#sessions.get(sessionId),
    })
    this.#approvals = new SessionApprovalCoordinator({
      configStore: this.#configStore,
      pluginBus: this.#pluginBus,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#setRunStatus(session, run, status, error),
    })
    this.#contextGate = new SessionContextGate({
      configStore: this.#configStore,
      approvals: this.#approvals,
    })
    this.#providerTurns = new SessionProviderTurnRunner({
      configStore: this.#configStore,
      toolRegistry: this.#toolRegistry,
      pluginBus: this.#pluginBus,
      promptRegistry: options.promptRegistry,
      fetchImpl: this.#fetchImpl,
      providerFactory: this.#providerFactory,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
    })
    this.#terminals = new SessionTerminalController({
      getScrollbackBytes: () =>
        this.#configStore.getPublicConfig().limits.terminalScrollbackBytes,
      emit: (event) => this.#events.emitTerminal(event),
      requireSession: (sessionId) => this.#requireSession(sessionId),
    })
    registerReadOnlyTools(
      this.#toolRegistry,
      () => this.#configStore.getPublicConfig().limits,
    )
    registerFileTools(
      this.#toolRegistry,
      () => this.#configStore.getPublicConfig().limits,
    )
    registerProcessTools(this.#toolRegistry, () =>
      this.#configStore.getPublicConfig(),
    )
    registerGitReadOnlyTools(this.#toolRegistry, () =>
      this.#configStore.getPublicConfig(),
    )
    registerGitWriteTools(this.#toolRegistry, () =>
      this.#configStore.getPublicConfig(),
    )
    registerFetchTools(this.#toolRegistry, () =>
      this.#configStore.getPublicConfig(),
    )
    registerWebSearchTools(this.#toolRegistry, this.#configStore)
    registerTerminalTools(
      this.#toolRegistry,
      this.#terminals.pool,
      () => this.#configStore.getPublicConfig().limits.maxToolOutputBytes,
    )
    if (this.#skillsManager) {
      registerSkillTools(this.#toolRegistry, this.#skillsManager)
    }
    registerOrchestrationTools(this.#toolRegistry, {
      getSession: (sessionId) => this.#sessions.get(sessionId),
      emit: (session, event) => this.#emit(session, event),
    })
    this.#toolExecutor = new ToolExecutor(this.#toolRegistry)
    this.#toolRunner = new SessionToolRunner({
      configStore: this.#configStore,
      pluginBus: this.#pluginBus,
      changeHistory: this.#changeHistory,
      promptRegistry: options.promptRegistry,
      fetchImpl: this.#fetchImpl,
      autoApproverFactory: this.#autoApproverFactory,
      permissionPipeline: this.#permissionPipeline,
      toolExecutor: this.#toolExecutor,
      approvals: this.#approvals,
      contextGate: this.#contextGate,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#setRunStatus(session, run, status, error),
    })
    this.#pluginBus?.setToolRegistrationPort(this.#toolRegistry)
  }

  async createSession(input: {
    conversationId?: string
    workspace: string
    mode: PermissionMode
    provider: string
    initialHistory?: ProviderMessage[]
    providerRequestOverride?: JsonValue
    forkedFromEventId?: EventId
    skipInitialHarness?: boolean
  }): Promise<SessionId> {
    const publicConfig = this.#configStore.getPublicConfig()

    if (
      publicConfig.logging.enabled &&
      publicConfig.privacy.traceNoticeAccepted?.version !== TRACE_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Trace logging notice must be accepted before enabling full trace logs',
        { requiredVersion: TRACE_NOTICE_VERSION },
      )
    }

    if (
      input.forkedFromEventId &&
      publicConfig.privacy.traceNoticeAccepted?.version !== TRACE_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Trace logging notice must be accepted before forking a trace',
      )
    }

    const guard = await PathGuard.create(input.workspace)
    const sessionId = id<SessionId>('session')
    const logger =
      publicConfig.logging.enabled || input.forkedFromEventId
        ? await JsonlTraceLogger.create(this.#traceDirectory, sessionId)
        : new NullTraceLogger()
    const session: SessionState = {
      sessionId,
      conversationId: input.conversationId,
      workspace: guard.workspacePath,
      mode: input.mode,
      provider: input.provider,
      logger,
      history: structuredClone(input.initialHistory ?? []),
      promptLedger: [],
      nextPromptSeq: 1,
      providerRequestOverride: structuredClone(input.providerRequestOverride),
      forkedFromEventId: input.forkedFromEventId,
      eventSeq: 0,
      closed: false,
      clientRequests: new Map(),
    }

    this.#sessions.set(sessionId, session)
    if (!input.skipInitialHarness) {
      await appendInitialPromptHarness(session, {
        workspace: session.workspace,
        mode: session.mode,
        config: publicConfig,
        providerId: input.provider,
        promptRegistry: this.#promptRegistry,
        skillSummary: this.#skillsManager?.summaryPrompt(),
        toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      })
    }
    await session.logger.write({
      type: 'session.start',
      sessionId,
      workspace: session.workspace,
      model:
        getProviderConfig(publicConfig, input.provider)?.model ??
        getActiveProviderConfig(publicConfig).model,
      mode: input.mode,
      forkedFromEventId: input.forkedFromEventId,
    })
    await this.#pluginBus
      ?.emit('onSessionStart', {
        version: 1,
        sessionId,
        workspace: session.workspace,
        mode: input.mode,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin onSessionStart failed', error),
      )

    return sessionId
  }

  async updateSessionMode(
    sessionId: SessionId,
    mode: PermissionMode,
  ): Promise<boolean> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed || session.activeRun) {
      return false
    }

    await session.logger.write({
      type: 'session.mode',
      sessionId,
      mode,
    })
    session.mode = mode
    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config: this.#configStore.getPublicConfig(),
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      reason: 'permission_mode_changed',
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
    })
    return true
  }

  updatePlanStatus(input: { sessionId: SessionId; status: PlanStatus }): {
    accepted: boolean
    plan?: PlanState
  } {
    const session = this.#sessions.get(input.sessionId)

    if (!session || session.closed || session.activeRun || !session.plan) {
      return { accepted: false }
    }

    const openItems = session.plan.items.filter(
      (item) => item.status !== 'completed' && item.status !== 'cancelled',
    )

    if (input.status === 'completed' && openItems.length > 0) {
      return { accepted: false }
    }

    const previousStatus = session.plan.status ?? 'active'
    session.plan.status = input.status
    session.plan.updatedAt = new Date().toISOString()

    if (input.status === 'active' && previousStatus !== 'active') {
      session.plan.continuationCount = 0
      delete session.plan.warning
    }

    return { accepted: true, plan: structuredClone(session.plan) }
  }

  async closeSession(sessionId: SessionId): Promise<boolean> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      return false
    }

    session.closed = true
    const logger = session.logger

    if (session.activeRun) {
      this.#supersedePendingInterjections(session, session.activeRun)
      session.activeRun.controller.abort(new Error('Session closed'))
      session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
      const completed = await Promise.race([
        session.activeRun.done.then(() => true),
        delay(RUN_CANCEL_GRACE_MS).then(() => false),
      ])

      if (!completed) {
        session.logger = new NullTraceLogger()
        this.#onDiagnostic(
          `Run ${session.activeRun.runId} did not stop within the cancellation grace period`,
        )
      }
    }

    this.#terminals.closeSession(sessionId)

    await this.#pluginBus
      ?.emit('onSessionEnd', {
        version: 1,
        sessionId,
        reason: 'closed',
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin onSessionEnd failed', error),
      )
    await logger.write({ type: 'session.end', sessionId })
    await logger.dispose()
    this.#emit(session, { type: 'session.closed', sessionId })
    this.#sessions.delete(sessionId)
    await this.#cleanupTraces()
    return true
  }

  startRun(input: {
    sessionId: SessionId
    message: string
    clientRequestId: string
    context?: RunContext
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    const existing = session.clientRequests.get(input.clientRequestId)

    if (existing) {
      return existing
    }

    return this.#startSessionRun(
      session,
      input.clientRequestId,
      input.message,
      input.context,
    )
  }

  async createForkFromTrace(input: {
    workspace: string
    mode: PermissionMode
    messages: ProviderMessage[]
    providerRequest: JsonValue
    sourceEventId: EventId
  }): Promise<{ sessionId: SessionId }> {
    const sessionId = await this.createSession({
      workspace: input.workspace,
      mode: input.mode,
      provider: this.#configStore.getPublicConfig().activeProviderId,
      initialHistory: input.messages,
      providerRequestOverride: input.providerRequest,
      forkedFromEventId: input.sourceEventId,
      skipInitialHarness: true,
    })
    return { sessionId }
  }

  startForkRun(sessionId: SessionId): RunId {
    const session = this.#requireSession(sessionId)

    if (
      session.forkedFromEventId === undefined ||
      session.providerRequestOverride === undefined
    ) {
      ipcFault('PRECONDITION_FAILED', 'Session is not a prepared trace fork')
    }

    return this.#startSessionRun(session, `fork-${session.forkedFromEventId}`)
  }

  activeTraceIds(): Set<string> {
    return new Set([...this.#sessions.keys()])
  }

  #startSessionRun(
    session: SessionState,
    clientRequestId: string,
    userMessage?: string,
    context?: RunContext,
  ): RunId {
    const config = this.#configStore.getPublicConfig()

    if (
      config.privacy.providerNoticeAccepted?.version !== PROVIDER_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Provider data egress notice must be accepted before starting a run',
        { requiredVersion: PROVIDER_NOTICE_VERSION },
      )
    }

    const provider = getProviderConfig(config, session.provider)

    if (!provider?.credentialConfigured) {
      ipcFault(
        'PRECONDITION_FAILED',
        `${provider?.label ?? session.provider} credential is not configured`,
      )
    }

    if (session.activeRun && isTerminalRunStatus(session.activeRun.status)) {
      session.activeRun = undefined
    }

    if (session.activeRun) {
      ipcFault('CONFLICT', 'This session already has an active run')
    }

    const runId = id<RunId>('run')
    const controller = new AbortController()
    const run: ActiveRun = {
      runId,
      clientRequestId,
      controller,
      status: 'idle',
      toolTokensUsed: 0,
      done: Promise.resolve(),
      pendingInterjections: [],
      processedInterjectionIds: new Set(),
    }

    run.done = this.#run(session, run, userMessage, context)
      .catch((error: unknown) =>
        this.#onDiagnostic(`Run ${run.runId} ended unexpectedly`, error),
      )
      .finally(() => {
        if (session.activeRun === run) {
          session.activeRun = undefined
        }
      })
    session.activeRun = run
    session.clientRequests.set(clientRequestId, runId)
    return runId
  }

  interruptRun(sessionId: SessionId, runId: RunId): boolean {
    const session = this.#requireSession(sessionId)

    if (!session.activeRun || session.activeRun.runId !== runId) {
      return false
    }

    this.#setRunStatus(session, session.activeRun, 'cancelling')
    this.#supersedePendingInterjections(session, session.activeRun)
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    session.activeRun.controller.abort(new Error('Run interrupted'))
    return true
  }

  interjectRun(input: {
    sessionId: SessionId
    runId: RunId
    message: string
    clientRequestId: string
  }): boolean {
    const session = this.#requireSession(input.sessionId)
    const run = session.activeRun

    if (!run || run.runId !== input.runId) {
      ipcFault('CONFLICT', 'The session does not have an active run')
    }

    if (run.status === 'cancelling') {
      ipcFault('CONFLICT', 'The active run is already cancelling')
    }

    // Idempotent: a repeated clientRequestId is a no-op across the full
    // interjection lifecycle (queued, injected, superseded, carried over), so
    // retried IPC cannot re-queue an already-handled interjection.
    if (run.processedInterjectionIds.has(input.clientRequestId)) {
      return true
    }

    const interjection: RunInterjection = {
      id: input.clientRequestId,
      clientRequestId: input.clientRequestId,
      conversationId: session.conversationId,
      runId: run.runId,
      content: input.message,
      createdAt: new Date().toISOString(),
      status: 'queued',
    }
    run.pendingInterjections.push(interjection)
    run.processedInterjectionIds.add(input.clientRequestId)
    this.#emitInterjectionEvent(session, interjection)
    void this.#logInterjection(session, interjection)
    return true
  }

  decideApproval(input: {
    sessionId: SessionId
    runId: RunId
    callId: CallId
    decision: 'allow' | 'deny'
    remember?: RememberApprovalInput
  }): boolean {
    const session = this.#requireSession(input.sessionId)
    return this.#approvals.decide(session, input)
  }

  async openTerminal(input: {
    sessionId: SessionId
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    return this.#terminals.open(input)
  }

  listTerminals(sessionId: SessionId): TerminalInfo[] {
    return this.#terminals.list(sessionId)
  }

  sendTerminalInput(
    sessionId: SessionId,
    terminalId: TerminalId,
    data: string,
  ): boolean {
    return this.#terminals.write(sessionId, terminalId, data)
  }

  resizeTerminal(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    return this.#terminals.resize(sessionId, terminalId, cols, rows)
  }

  closeTerminal(sessionId: SessionId, terminalId: TerminalId): boolean {
    return this.#terminals.close(sessionId, terminalId)
  }

  terminalSnapshot(
    sessionId: SessionId,
    terminalId: TerminalId,
  ): TerminalSnapshot {
    return this.#terminals.snapshot(sessionId, terminalId)
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((idValue) => this.closeSession(idValue)),
    )
    await this.#terminals.dispose()
  }

  #requireSession(sessionId: SessionId): SessionState {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      ipcFault('NOT_FOUND', 'Session not found')
    }

    return session
  }

  async #run(
    session: SessionState,
    run: ActiveRun,
    userMessage?: string,
    context?: RunContext,
  ): Promise<void> {
    const signal = run.controller.signal

    try {
      if (userMessage !== undefined) {
        if (isCompactSlashCommand(userMessage)) {
          await this.#runCompactCommand(session, run, userMessage)
          await this.#finishRun(session, run, 'completed')
          return
        }

        const prepared = await this.#prepareUserTurn(
          session,
          run,
          userMessage,
          context,
        )
        run.currentTurnStartIndex = session.history.length
        for (const appMessage of prepared.appMessages) {
          appendPromptLayer(session, {
            kind: appMessage.kind,
            role: 'user',
            content: appMessage.content,
            source: appMessage.source,
            trusted: false,
            editable: false,
            config: this.#configStore.getPublicConfig(),
          })
        }
        session.history.push({
          role: 'user',
          content: prepared.providerMessage,
        })
        await session.logger.write({
          type: 'user.message',
          sessionId: session.sessionId,
          runId: run.runId,
          text: prepared.visibleMessage,
        })
      }
      await session.logger.write({
        type: 'run.start',
        sessionId: session.sessionId,
        runId: run.runId,
      })

      for (
        let step = 0;
        step < this.#configStore.getPublicConfig().limits.maxStepsPerRun;
        step += 1
      ) {
        if (signal.aborted) {
          throw signal.reason
        }

        // Inject queued interjections at the tool-batch boundary, before the
        // next model continuation. This runs after the previous tool batch has
        // completed (and never splits an assistant tool_call from its
        // tool_result, because executeToolCalls has already finished).
        await this.#drainInterjections(session, run)
        await this.#maybeAutoCompactBeforeProviderCall(session, run)

        const completed = await this.#providerTurns.callProvider(
          session,
          run,
          () => this.#setRunStatus(session, run, 'calling_llm'),
        )

        session.history.push(completed.turn)

        if (completed.text || completed.reasoning) {
          this.#emit(session, {
            type: 'assistant.message.completed',
            sessionId: session.sessionId,
            runId: run.runId,
            text: completed.text,
            ...(completed.reasoning ? { reasoning: completed.reasoning } : {}),
          })
          await session.logger.write({
            type: 'agent.message',
            sessionId: session.sessionId,
            runId: run.runId,
            text: completed.text,
            reasoning: completed.reasoning || undefined,
          })
        }

        if (completed.toolCalls.length === 0) {
          const continuation = await this.#nextOrchestrationStep(session, run)
          if (continuation === 'continue') {
            continue
          }

          if (run.pendingInterjections.length > 0) {
            // The assistant reached a final answer with no further
            // continuation. Per the roadmap, pending interjections become the
            // next ordinary user turn rather than forcing extra continuations
            // of this run (which would overwrite the final answer in the
            // renderer). Carry them over so the renderer starts a fresh run.
            await this.#carryOverInterjections(session, run)
          }

          await this.#finishRun(session, run, 'completed')
          return
        }

        this.#setRunStatus(session, run, 'evaluating_tools')
        run.lastToolBatchId = id('tool-batch')
        await this.#toolRunner.executeToolCalls(
          session,
          run,
          completed.toolCalls,
        )
      }

      throw new Error('Run exceeded maxStepsPerRun')
    } catch (error) {
      const status = finalStatusFromError(error, signal)
      await this.#finishRun(session, run, status, error)
    }
  }

  async #maybeAutoCompactBeforeProviderCall(
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

    const prompt = this.#orchestrationPrompt('compact')
    const text = [
      prompt.text,
      '',
      `Automatic compact trigger: estimated prompt reached ${config.limits.autoCompactTriggerPercent}% of the current prompt budget.`,
      'Summarize only the older history before the current user turn; the current turn will remain available verbatim after compaction.',
    ].join('\n')

    await this.#emitOrchestratorMessage(session, run, {
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

  async #runCompactCommand(
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
    await this.#emitOrchestratorMessage(session, run, {
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

  async #prepareUserTurn(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
    context?: RunContext,
  ): Promise<{
    visibleMessage: string
    providerMessage: string
    appMessages: Array<{
      kind: 'selected_context' | 'orchestration_request' | 'user_interjection'
      content: string
      source: string
    }>
  }> {
    const config = this.#configStore.getPublicConfig()
    await appendRuntimeContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      reason: 'run_started',
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      signal: run.controller.signal,
    })
    await appendAgentsContextIfChanged(session, {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: session.provider,
      promptRegistry: this.#promptRegistry,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      signal: run.controller.signal,
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

    if (command.plan) {
      session.plan = command.plan
      this.#emit(session, {
        type: 'plan.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        plan: structuredClone(command.plan),
      })
    }

    if (command.orchestratorMessage) {
      await this.#emitOrchestratorMessage(session, run, {
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

    const appMessages: Array<{
      kind: 'selected_context' | 'orchestration_request' | 'user_interjection'
      content: string
      source: string
    }> = []

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
      appMessages,
    }
  }

  async #nextOrchestrationStep(
    session: SessionState,
    run: ActiveRun,
  ): Promise<'continue' | 'finish'> {
    const goal = session.goal

    if (goal?.status === 'active') {
      if (goal.continuationCount >= MAX_GOAL_CONTINUATIONS) {
        goal.status = 'paused'
        goal.updatedAt = new Date().toISOString()
        this.#emit(session, {
          type: 'goal.updated',
          sessionId: session.sessionId,
          runId: run.runId,
          goal: structuredClone(goal),
        })
        await this.#emitOrchestratorMessage(session, run, {
          kind: 'goal-paused',
          text: 'Goal auto-continuation limit reached. The Goal was paused instead of being marked complete.',
          injectIntoHistory: false,
        })
        return 'finish'
      }

      goal.continuationCount += 1
      goal.updatedAt = new Date().toISOString()
      this.#emit(session, {
        type: 'goal.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        goal: structuredClone(goal),
      })
      const prompt = this.#orchestrationPrompt('goalContinue')
      await this.#emitOrchestratorMessage(session, run, {
        kind: 'goal-continuation',
        text: [
          prompt.text,
          '',
          `Goal objective: ${goal.objective}`,
          `Goal state: ${JSON.stringify(goal)}`,
          session.plan
            ? `Current plan state: ${JSON.stringify(session.plan)}`
            : 'Current plan state: none',
        ].join('\n'),
        resource: prompt.resource,
        injectIntoHistory: true,
      })
      return 'continue'
    }

    const plan = session.plan
    const openItems = (plan?.items ?? []).filter(
      (item) => item.status !== 'completed' && item.status !== 'cancelled',
    )

    if (
      !plan ||
      (plan.status ?? 'active') !== 'active' ||
      openItems.length === 0
    ) {
      return 'finish'
    }

    if (plan.continuationCount < 1) {
      plan.continuationCount += 1
      plan.updatedAt = new Date().toISOString()
      this.#emit(session, {
        type: 'plan.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        plan: structuredClone(plan),
      })
      const prompt = this.#orchestrationPrompt('planContinue')
      await this.#emitOrchestratorMessage(session, run, {
        kind: 'plan-continuation',
        text: [
          prompt.text,
          '',
          `Plan objective: ${plan.objective}`,
          `Open plan items: ${JSON.stringify(openItems)}`,
        ].join('\n'),
        resource: prompt.resource,
        injectIntoHistory: true,
      })
      return 'continue'
    }

    const prompt = this.#orchestrationPrompt('planWarning')
    plan.warning = prompt.text
    plan.updatedAt = new Date().toISOString()
    this.#emit(session, {
      type: 'plan.updated',
      sessionId: session.sessionId,
      runId: run.runId,
      plan: structuredClone(plan),
    })
    await this.#emitOrchestratorMessage(session, run, {
      kind: 'plan-warning',
      text: prompt.text,
      resource: prompt.resource,
      injectIntoHistory: false,
    })
    return 'finish'
  }

  #orchestrationPrompt(
    kind: 'goalContinue' | 'planContinue' | 'planWarning' | 'compact',
  ): {
    text: string
    resource?: PromptResourceSummary
  } {
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

  async #drainInterjections(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    const pending = run.pendingInterjections
    if (pending.length === 0) return

    const batchId = run.lastToolBatchId
    const config = this.#configStore.getPublicConfig()
    const toInject = pending.splice(0, pending.length)

    // Multiple queued interjections are flushed in arrival order. Each one is
    // injected as its own pinned prompt layer and persisted/traced separately,
    // even though they all flow into the same model continuation.
    for (const interjection of toInject) {
      appendPromptLayer(session, {
        kind: 'user_interjection',
        role: 'user',
        content: liveUserInterjectionContent(interjection.content),
        source: 'run.interjection',
        trusted: false,
        editable: false,
        config,
      })
      interjection.status = 'injected'
      if (batchId) {
        interjection.injectedAfterToolBatchId = batchId
      }
      this.#emitInterjectionEvent(session, interjection)
      await this.#logInterjection(session, interjection)
    }
  }

  #supersedePendingInterjections(session: SessionState, run: ActiveRun): void {
    for (const interjection of run.pendingInterjections) {
      if (interjection.status === 'queued') {
        interjection.status = 'superseded'
        this.#emitInterjectionEvent(session, interjection)
        void this.#logInterjection(session, interjection)
      }
    }
    run.pendingInterjections = []
  }

  async #carryOverInterjections(
    session: SessionState,
    run: ActiveRun,
  ): Promise<void> {
    // Final-answer branch: pending interjections become the next ordinary
    // user turn. Emit a carryover signal (and trace) for each, then drop them
    // from this run so the renderer can start a fresh run with the content.
    const toCarry = run.pendingInterjections.splice(
      0,
      run.pendingInterjections.length,
    )
    for (const interjection of toCarry) {
      this.#emit(session, {
        type: 'interjection.carryover',
        sessionId: session.sessionId,
        runId: run.runId,
        interjectionId: interjection.id,
        content: interjection.content,
        createdAt: interjection.createdAt,
      })
      await session.logger.write({
        type: 'interjection.message',
        sessionId: session.sessionId,
        runId: run.runId,
        interjectionId: interjection.id,
        status: 'carryover',
        content: interjection.content,
        createdAt: interjection.createdAt,
      })
    }
  }

  #emitInterjectionEvent(
    session: SessionState,
    interjection: RunInterjection,
  ): void {
    this.#emit(session, {
      type: 'interjection.updated',
      sessionId: session.sessionId,
      runId: interjection.runId,
      interjectionId: interjection.id,
      status: interjection.status,
      content: interjection.content,
      createdAt: interjection.createdAt,
      ...(interjection.injectedAfterToolBatchId
        ? {
            injectedAfterToolBatchId: interjection.injectedAfterToolBatchId,
          }
        : {}),
    })
  }

  async #logInterjection(
    session: SessionState,
    interjection: RunInterjection,
  ): Promise<void> {
    await session.logger.write({
      type: 'interjection.message',
      sessionId: session.sessionId,
      runId: interjection.runId,
      interjectionId: interjection.id,
      status: interjection.status,
      content: interjection.content,
      createdAt: interjection.createdAt,
      ...(interjection.injectedAfterToolBatchId
        ? {
            injectedAfterToolBatchId: interjection.injectedAfterToolBatchId,
          }
        : {}),
    })
  }

  async #emitOrchestratorMessage(
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

  async #finishRun(
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ): Promise<void> {
    this.#setRunStatus(session, run, status, error)
    await session.logger.write({
      type: 'run.end',
      sessionId: session.sessionId,
      runId: run.runId,
      status,
    })
  }

  #setRunStatus(
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ): void {
    run.status = status
    this.#emit(session, {
      type: 'run.status',
      sessionId: session.sessionId,
      runId: run.runId,
      status,
      ...(error && status === 'failed'
        ? {
            error: {
              code: 'RUN_FAILED',
              message:
                error instanceof Error
                  ? error.message
                  : 'Run failed unexpectedly',
            },
          }
        : {}),
    })
  }

  #emit(session: SessionState, event: AgentEventDraft): void {
    this.#events.emitAgent(session, event)
  }

  async #cleanupTraces(): Promise<void> {
    const config = this.#configStore.getPublicConfig()
    const activeFiles = new Set(
      [...this.#sessions.keys()].map((sessionId) =>
        path.resolve(this.#traceDirectory, `${sessionId}.jsonl`),
      ),
    )

    await cleanupTraces(this.#traceDirectory, {
      retentionDays: config.logging.retentionDays,
      maxTotalBytes: config.logging.maxTotalBytes,
      activeFiles,
      onDiagnostic: this.#onDiagnostic,
    })
  }
}
