import path from 'node:path'
import type { PermissionMode } from '../../shared/config'
import type { RunStatus } from '../../shared/agent-events'
import type {
  CallId,
  EventId,
  RunId,
  SessionId,
  TerminalId,
} from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
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

const RUN_CANCEL_GRACE_MS = 2_000

export class SessionManager {
  readonly #configStore: ConfigStore
  readonly #traceDirectory: string
  readonly #getWebContents: SessionManagerOptions['getWebContents']
  readonly #pluginBus: PluginEventBus | undefined
  readonly #skillsManager: SkillsManager | undefined
  readonly #changeHistory: ChangeHistoryStore | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
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
    this.#providerFactory = options.providerFactory
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
    registerFileTools(this.#toolRegistry)
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
    this.#toolExecutor = new ToolExecutor(this.#toolRegistry)
    this.#toolRunner = new SessionToolRunner({
      configStore: this.#configStore,
      pluginBus: this.#pluginBus,
      changeHistory: this.#changeHistory,
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
    provider: 'deepseek'
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
      model: publicConfig.providers.deepseek.model,
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
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    const existing = session.clientRequests.get(input.clientRequestId)

    if (existing) {
      return existing
    }

    return this.#startSessionRun(session, input.clientRequestId, input.message)
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
      provider: 'deepseek',
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

    if (!config.providers.deepseek.credentialConfigured) {
      ipcFault('PRECONDITION_FAILED', 'DeepSeek credential is not configured')
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

    run.done = this.#run(session, run, userMessage)
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
  ): Promise<void> {
    const signal = run.controller.signal

    try {
      if (userMessage !== undefined) {
        session.history.push({ role: 'user', content: userMessage })
        await session.logger.write({
          type: 'user.message',
          sessionId: session.sessionId,
          runId: run.runId,
          text: userMessage,
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
          await session.logger.write({
            type: 'agent.message',
            sessionId: session.sessionId,
            runId: run.runId,
            text: completed.text,
            reasoning: completed.reasoning || undefined,
          })
        }

        if (completed.toolCalls.length === 0) {
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
