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
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import { JsonlTraceLogger, NullTraceLogger } from '../logging/logger'
import { cleanupTraces } from '../logging/cleanup'
import type { PluginEventBus } from '../plugins/event-bus'
import { PathGuard } from './path-guard'
import type { ProviderMessage } from './provider'
import { registerReadOnlyTools } from './readonly-tools'
import { registerFileTools } from './file-tools'
import { registerProcessTools } from './process-tools'
import {
  PermissionPipeline,
  type RememberApprovalInput,
} from './permission-pipeline'
import type { ChangeHistoryStore } from './change-history'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import { registerTerminalTools } from './terminal-tools'
import type { SkillsManager } from '../skills/manager'
import { registerSkillTools } from './skill-tools'
import { delay, finalStatusFromError } from './session-run-utils'
import { id, ipcFault } from './session-common'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import { SessionEventEmitter } from './session-events'
import { SessionTerminalController } from './session-terminals'
import { SessionApprovalCoordinator } from './session-approval'
import { SessionContextGate } from './session-context-gate'
import { SessionProviderTurnRunner } from './session-provider-turn'
import { SessionToolRunner } from './session-tool-runner'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import { prepareRunContext } from './context-attachments'
import { resolveSlashCommand } from './slash-commands'
import { registerOrchestrationTools } from './orchestration-tools'

const RUN_CANCEL_GRACE_MS = 2_000
const MAX_GOAL_CONTINUATIONS = 8

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
      skillsManager: this.#skillsManager,
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
    systemPromptOverride?: string
    providerRequestOverride?: JsonValue
    forkedFromEventId?: EventId
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
      systemPromptOverride: input.systemPromptOverride,
      providerRequestOverride: structuredClone(input.providerRequestOverride),
      forkedFromEventId: input.forkedFromEventId,
      eventSeq: 0,
      closed: false,
      clientRequests: new Map(),
    }

    this.#sessions.set(sessionId, session)
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
    return true
  }

  async closeSession(sessionId: SessionId): Promise<boolean> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      return false
    }

    session.closed = true
    const logger = session.logger

    if (session.activeRun) {
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
    const system = input.messages.find((message) => message.role === 'system')
    const history = input.messages.filter(
      (message) => message.role !== 'system',
    )
    const sessionId = await this.createSession({
      workspace: input.workspace,
      mode: input.mode,
      provider: this.#configStore.getPublicConfig().activeProviderId,
      initialHistory: history,
      systemPromptOverride:
        typeof system?.content === 'string' ? system.content : undefined,
      providerRequestOverride: input.providerRequest,
      forkedFromEventId: input.sourceEventId,
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
    session.activeRun.pendingApproval?.resolve({ decision: 'cancelled' })
    session.activeRun.controller.abort(new Error('Run interrupted'))
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
        const prepared = await this.#prepareUserTurn(
          session,
          run,
          userMessage,
          context,
        )
        if (prepared.contextMessage) {
          session.history.push({
            role: 'user',
            content: prepared.contextMessage,
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

          await this.#finishRun(session, run, 'completed')
          return
        }

        this.#setRunStatus(session, run, 'evaluating_tools')
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

  async #prepareUserTurn(
    session: SessionState,
    run: ActiveRun,
    userMessage: string,
    context?: RunContext,
  ): Promise<{
    visibleMessage: string
    providerMessage: string
    contextMessage?: string
  }> {
    const config = this.#configStore.getPublicConfig()
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

    return {
      visibleMessage: command.visibleMessage,
      providerMessage: command.providerMessage,
      contextMessage: preparedContext.providerContent || undefined,
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

    if (!plan || openItems.length === 0) {
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

  #orchestrationPrompt(kind: 'goalContinue' | 'planContinue' | 'planWarning'): {
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
      session.history.push({
        role: 'user',
        content: input.text,
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
