import path from 'node:path'
import { getProviderConfig, type PermissionMode } from '../../shared/config'
import type { CallId, RunId, SessionId, TerminalId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { RunContext } from '../../shared/context'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import type { PlanState, PlanStatus } from '../../shared/orchestration'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import { JsonlTraceLogger, NullTraceLogger } from '../logging/logger'
import { cleanupTraces } from '../logging/cleanup'
import type { PluginEventBus } from '../plugins/event-bus'
import { PathGuard } from '../safety/path-guard'
import {
  PermissionPipeline,
  type RememberApprovalInput,
} from '../permission/permission-pipeline'
import type { ChangeHistoryStore } from './change-history'
import type { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import type { SkillsManager } from '../skills/manager'
import { id, ipcFault, toJsonValue } from './session-common'
import type {
  AgentEventDraft,
  HarnessRunMessage,
  RunHarnessContext,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import { SessionEventEmitter } from './session-events'
import { SessionTerminalController } from './session-terminals'
import { SessionApprovalCoordinator } from '../permission/session-approval'
import { SessionContextGate } from './session-context-gate'
import { SessionProviderTurnRunner } from './session-provider-turn'
import { SessionToolRunner } from './session-tool-runner'
import type { PromptRegistry } from '../prompts/registry'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'
import { SessionOrchestratorMessages } from './session-orchestrator-messages'
import { createSessionTooling, type SessionTooling } from './session-tooling'
import type { McpManager } from '../mcp/mcp-manager'
import { SessionCompactCoordinator } from './session-compact-coordinator'
import { SessionInterjectionCoordinator } from './session-interjection-coordinator'
import { SessionOrchestrationPlanner } from './session-orchestration-planner'
import { SessionUserTurnPreparer } from './session-user-turn-preparer'
import { SessionRunController } from './session-run-controller'
import {
  appendInitialPromptHarness,
  appendRuntimeContextIfChanged,
  type WorkspaceConcurrencyContext,
} from './prompt-harness'
import {
  WorkspaceAccessCoordinator,
  type RunAccessLease,
  type RunAccessRejection,
  type WorkspaceWriterOwner,
} from './workspace-access-coordinator'

const RUN_CANCEL_GRACE_MS = 2_000

/**
 * Main-process facade for agent sessions.
 *
 * The manager owns the session map, lifecycle checks, trace logger ownership,
 * terminal facade methods, and IPC-facing method signatures. It delegates the
 * long-running agent loop and specialized state machines to session-scoped
 * collaborators so this class stays focused on orchestration boundaries.
 */
export class SessionManager {
  readonly #configStore: ConfigStore
  readonly #traceDirectory: string
  readonly #pluginBus: PluginEventBus | undefined
  readonly #skillsManager: SkillsManager | undefined
  readonly #changeHistory: ChangeHistoryStore | undefined
  readonly #projectMetadata: ProjectMetadataStore | undefined
  readonly #codeBackends: CodeBackendManager | undefined
  readonly #mcpManager: McpManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #sessions = new Map<SessionId, SessionState>()
  readonly #writerEventSessions = new Map<RunId, SessionState>()
  readonly #toolRegistry: ToolRegistry
  readonly #toolExecutor: ToolExecutor
  readonly #mcpGateway: SessionTooling['mcpGateway']
  readonly #events: SessionEventEmitter
  readonly #terminals: SessionTerminalController
  readonly #approvals: SessionApprovalCoordinator
  readonly #contextGate: SessionContextGate
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #compact: SessionCompactCoordinator
  readonly #interjections: SessionInterjectionCoordinator
  readonly #orchestration: SessionOrchestrationPlanner
  readonly #userTurns: SessionUserTurnPreparer
  readonly #runs: SessionRunController
  readonly #workspaceAccess: WorkspaceAccessCoordinator
  readonly #permissionPipeline = new PermissionPipeline()

  /**
   * Wires session collaborators around shared session state.
   *
   * Some collaborators receive callbacks that reference `#runs`; those
   * callbacks are invoked only after construction completes and the run
   * controller has been assigned.
   */
  constructor(options: SessionManagerOptions) {
    this.#configStore = options.configStore
    this.#traceDirectory = options.traceDirectory
    this.#pluginBus = options.pluginBus
    this.#skillsManager = options.skillsManager
    this.#changeHistory = options.changeHistory
    this.#projectMetadata = options.projectMetadata
    this.#codeBackends = options.codeBackends
    this.#mcpManager = options.mcpManager
    this.#promptRegistry = options.promptRegistry
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#autoApproverFactory = options.autoApproverFactory
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.#events = new SessionEventEmitter({
      eventSink: options.eventSink,
      getSession: (sessionId) => this.#sessions.get(sessionId),
    })
    this.#workspaceAccess = new WorkspaceAccessCoordinator({
      onWriterChanged: (status, owner) =>
        this.#handleWorkspaceWriterChanged(status, owner),
    })
    this.#approvals = new SessionApprovalCoordinator({
      configStore: this.#configStore,
      pluginBus: this.#pluginBus,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#runs.setRunStatus(session, run, status, error),
    })
    this.#contextGate = new SessionContextGate({
      configStore: this.#configStore,
      approvals: this.#approvals,
    })
    this.#orchestratorMessages = new SessionOrchestratorMessages({
      configStore: this.#configStore,
      promptRegistry: this.#promptRegistry,
      emit: (session, event) => this.#emit(session, event),
    })
    this.#terminals = new SessionTerminalController({
      getScrollbackBytes: () =>
        this.#configStore.getPublicConfig().limits.terminalScrollbackBytes,
      emit: (event) => this.#events.emitTerminal(event),
      requireSession: (sessionId) => this.#requireSession(sessionId),
    })
    const tooling = createSessionTooling({
      configStore: this.#configStore,
      terminals: this.#terminals,
      skillsManager: this.#skillsManager,
      projectMetadata: this.#projectMetadata,
      codeBackends: this.#codeBackends,
      mcpManager: options.mcpManager,
      getSession: (sessionId) => this.#sessions.get(sessionId),
      emit: (session, event) => this.#emit(session, event),
    })
    this.#toolRegistry = tooling.toolRegistry
    this.#toolExecutor = tooling.toolExecutor
    this.#mcpGateway = tooling.mcpGateway
    this.#compact = new SessionCompactCoordinator({
      configStore: this.#configStore,
      toolRegistry: this.#toolRegistry,
      skillsManager: this.#skillsManager,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      providerFactory: this.#providerFactory,
      fetchImpl: this.#fetchImpl,
      orchestratorMessages: this.#orchestratorMessages,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#runs.setRunStatus(session, run, status, error),
      getWorkspaceConcurrency: (session) =>
        this.#workspaceConcurrencyContext(session),
    })
    this.#interjections = new SessionInterjectionCoordinator({
      configStore: this.#configStore,
      emit: (session, event) => this.#emit(session, event),
    })
    this.#orchestration = new SessionOrchestrationPlanner({
      orchestratorMessages: this.#orchestratorMessages,
      emit: (session, event) => this.#emit(session, event),
    })
    this.#userTurns = new SessionUserTurnPreparer({
      configStore: this.#configStore,
      toolRegistry: this.#toolRegistry,
      skillsManager: this.#skillsManager,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      orchestratorMessages: this.#orchestratorMessages,
      emit: (session, event) => this.#emit(session, event),
      getWorkspaceConcurrency: (session) =>
        this.#workspaceConcurrencyContext(session),
    })
    const providerTurns = new SessionProviderTurnRunner({
      configStore: this.#configStore,
      toolRegistry: this.#toolRegistry,
      pluginBus: this.#pluginBus,
      promptRegistry: options.promptRegistry,
      projectMetadata: this.#projectMetadata,
      fetchImpl: this.#fetchImpl,
      providerFactory: this.#providerFactory,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      getWorkspaceConcurrency: (session) =>
        this.#workspaceConcurrencyContext(session),
    })
    const toolRunner = new SessionToolRunner({
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
      mcpGateway: this.#mcpGateway,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#runs.setRunStatus(session, run, status, error),
    })
    this.#runs = new SessionRunController({
      configStore: this.#configStore,
      providerTurns,
      toolRunner,
      compact: this.#compact,
      interjections: this.#interjections,
      orchestration: this.#orchestration,
      userTurns: this.#userTurns,
      onDiagnostic: this.#onDiagnostic,
      emit: (session, event) => this.#emit(session, event),
      acquireRunAccess: (session, runId) =>
        this.#acquireRunAccess(session, runId),
    })
    this.#pluginBus?.setToolRegistrationPort(this.#toolRegistry)
  }

  /**
   * Creates a session bound to a guarded workspace and optional trace logger.
   *
   * Every session receives canonical initial harness messages immediately.
   */
  async createSession(input: {
    conversationId?: string
    workspace: string
    mode: PermissionMode
    provider: string
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

    const provider = getProviderConfig(publicConfig, input.provider)
    if (!provider) {
      ipcFault(
        'PRECONDITION_FAILED',
        `Provider is not configured: ${input.provider}`,
      )
    }
    const guard = await PathGuard.create(input.workspace)
    await this.#mcpManager?.activateWorkspace(guard.workspacePath)
    const sessionId = id<SessionId>('session')
    const logger = publicConfig.logging.enabled
      ? await JsonlTraceLogger.create(this.#traceDirectory, sessionId)
      : new NullTraceLogger()
    const session: SessionState = {
      sessionId,
      conversationId: input.conversationId,
      workspace: guard.workspacePath,
      mode: input.mode,
      provider: provider.id,
      modelSelection: {
        providerId: provider.id,
        model: provider.model,
        reasoning: provider.reasoning,
      },
      logger,
      history: [],
      nextMessageSeq: 1,
      eventSeq: 0,
      closed: false,
      clientRequests: new Map(),
      mcpDisclosures: new Map(),
    }

    this.#sessions.set(sessionId, session)
    await appendInitialPromptHarness(session, {
      workspace: session.workspace,
      mode: session.mode,
      config: publicConfig,
      providerId: provider.id,
      promptRegistry: this.#promptRegistry,
      projectMetadata: this.#projectMetadata,
      skillSummary: this.#skillsManager?.summaryPrompt(),
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
      workspaceConcurrency: this.#workspaceConcurrencyContext(session),
    })
    await session.logger.write({
      type: 'session.start',
      sessionId,
      conversationId: input.conversationId,
      workspace: session.workspace,
      model: provider.model,
      mode: input.mode,
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

  /**
   * Changes the permission mode for an idle session.
   *
   * Active runs keep their original mode snapshot; mode changes are rejected
   * until the run finishes so approval and tool policy stay consistent.
   */
  async updateSessionMode(
    sessionId: SessionId,
    mode: PermissionMode,
  ): Promise<{
    accepted: boolean
    reason?: 'active_run' | 'workspace_writer_active'
    writerConversationId?: string
    writerRunId?: RunId
  }> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      return { accepted: false }
    }

    if (session.activeRun) {
      return { accepted: false, reason: 'active_run' }
    }

    const writer = this.#workspaceAccess.writerFor(session.workspace)
    if (mode !== 'readonly' && writer) {
      return {
        accepted: false,
        reason: 'workspace_writer_active',
        writerConversationId: writer.conversationId,
        writerRunId: writer.runId,
      }
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
      projectMetadata: this.#projectMetadata,
      reason: 'permission_mode_changed',
      workspaceConcurrency: this.#workspaceConcurrencyContext(session),
      toolNames: this.#toolRegistry.list().map((tool) => tool.id),
    })
    return { accepted: true }
  }

  /**
   * Applies a user-reviewed plan status transition.
   *
   * This is intentionally narrow UI control logic; model-created plan contents
   * and continuation behavior live in the orchestration tools/planner.
   */
  async updatePlanStatus(input: {
    sessionId: SessionId
    status: PlanStatus
    source?: 'ui:plan-review' | 'headless:auto-plan-approval'
  }): Promise<{
    accepted: boolean
    plan?: PlanState
  }> {
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

    await session.logger.write({
      type: 'plan.status',
      sessionId: input.sessionId,
      previousStatus,
      status: input.status,
      source: input.source ?? 'ui:plan-review',
      plan: toJsonValue(session.plan),
    })

    return { accepted: true, plan: structuredClone(session.plan) }
  }

  /**
   * Closes a session, cancels any active run, disposes terminals and trace
   * logging, emits the close event, then removes the session from memory.
   */
  async closeSession(sessionId: SessionId): Promise<boolean> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      return false
    }

    session.closed = true
    const logger = session.logger

    if (session.activeRun) {
      const completed = await this.#runs.cancelForSessionClose(
        session,
        RUN_CANCEL_GRACE_MS,
      )

      if (!completed) {
        this.#runs.releaseAccess(session.activeRun)
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

  /**
   * Starts a user-driven run for an existing session.
   *
   * The run controller owns idempotency, provider preconditions, and the
   * provider/tool loop; this method only resolves the session boundary.
   */
  startRun(input: {
    sessionId: SessionId
    message: string
    clientRequestId: string
    context?: RunContext
    harnessContexts?: RunHarnessContext[]
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    return this.#runs.start(
      session,
      input.clientRequestId,
      input.message,
      input.context,
      undefined,
      input.harnessContexts,
    )
  }

  startHarnessRun(input: {
    sessionId: SessionId
    clientRequestId: string
    message: HarnessRunMessage
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    return this.#runs.start(
      session,
      input.clientRequestId,
      undefined,
      undefined,
      input.message,
    )
  }

  /**
   * Returns trace ids that must not be deleted by retention cleanup.
   */
  activeTraceIds(): Set<string> {
    return new Set([...this.#sessions.keys()])
  }

  /**
   * Requests cancellation for a specific active run.
   */
  interruptRun(sessionId: SessionId, runId: RunId): boolean {
    const session = this.#requireSession(sessionId)
    return this.#runs.interrupt(session, runId)
  }

  providerToolDefinitions(): JsonValue[] {
    return structuredClone(this.#toolRegistry.providerDefinitions())
  }

  toolNames(): string[] {
    return this.#toolRegistry
      .list()
      .map((tool) => tool.id)
      .sort()
  }

  async waitForRunSettled(sessionId: SessionId, runId: RunId): Promise<void> {
    const session = this.#requireSession(sessionId)
    const run = session.activeRun
    if (run?.runId === runId) await run.done
  }

  /**
   * Queues a live user interjection for an active run.
   *
   * Interjections are injected only at safe provider/tool boundaries by the run
   * controller, so this method only validates the active run and delegates
   * queueing/idempotency.
   */
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

    return this.#interjections.queue(session, run, {
      message: input.message,
      clientRequestId: input.clientRequestId,
    })
  }

  /**
   * Applies a human approval decision to the active approval coordinator.
   */
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

  /**
   * Opens a PTY terminal owned by the session.
   */
  async openTerminal(input: {
    sessionId: SessionId
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    return this.#terminals.open(input)
  }

  /**
   * Lists live terminals for a session.
   */
  listTerminals(sessionId: SessionId): TerminalInfo[] {
    return this.#terminals.list(sessionId)
  }

  /**
   * Writes raw input to a session terminal.
   */
  sendTerminalInput(
    sessionId: SessionId,
    terminalId: TerminalId,
    data: string,
  ): boolean {
    return this.#terminals.write(sessionId, terminalId, data)
  }

  /**
   * Resizes a session terminal viewport.
   */
  resizeTerminal(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    return this.#terminals.resize(sessionId, terminalId, cols, rows)
  }

  /**
   * Closes one terminal in a session.
   */
  closeTerminal(sessionId: SessionId, terminalId: TerminalId): boolean {
    return this.#terminals.close(sessionId, terminalId)
  }

  /**
   * Returns a bounded terminal scrollback snapshot.
   */
  terminalSnapshot(
    sessionId: SessionId,
    terminalId: TerminalId,
  ): TerminalSnapshot {
    return this.#terminals.snapshot(sessionId, terminalId)
  }

  /**
   * Closes every session and disposes terminal infrastructure.
   */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((idValue) => this.closeSession(idValue)),
    )
    this.#workspaceAccess.releaseAll()
    await this.#terminals.dispose()
  }

  #acquireRunAccess(session: SessionState, runId: RunId): RunAccessLease {
    const result = this.#workspaceAccess.acquire({
      limit: this.#configStore.getPublicConfig().limits.maxConcurrentRuns,
      workspace: session.workspace,
      mode: session.mode,
      conversationId: session.conversationId ?? session.sessionId,
      sessionId: session.sessionId,
      runId,
    })

    if (result.acquired) {
      if (session.mode !== 'readonly') {
        this.#writerEventSessions.set(runId, session)
      }
      return result.lease
    }

    this.#traceRunAccessRejection(session, runId, result.rejection)
    if (result.rejection.reason === 'max_concurrent_runs') {
      ipcFault('CONFLICT', 'The maximum number of concurrent runs is active', {
        reason: result.rejection.reason,
        limit: result.rejection.limit,
        active: result.rejection.active,
      })
    }

    ipcFault('CONFLICT', 'Another run is modifying this workspace', {
      reason: result.rejection.reason,
      writerConversationId: result.rejection.writer.conversationId,
      writerRunId: result.rejection.writer.runId,
    })
  }

  #traceRunAccessRejection(
    session: SessionState,
    runId: RunId,
    rejection: RunAccessRejection,
  ): void {
    const common = {
      type: 'run.rejected' as const,
      sessionId: session.sessionId,
      runId,
    }
    const event =
      rejection.reason === 'max_concurrent_runs'
        ? {
            ...common,
            reason: rejection.reason,
            limit: rejection.limit,
            active: rejection.active,
          }
        : {
            ...common,
            reason: rejection.reason,
            writerConversationId: rejection.writer.conversationId,
            writerRunId: rejection.writer.runId,
          }
    void session.logger
      .write(event)
      .catch((error: unknown) =>
        this.#onDiagnostic('Failed to trace rejected run', error),
      )

    if (rejection.reason === 'workspace_writer_active') {
      void session.logger
        .write({
          type: 'workspace.writer',
          sessionId: session.sessionId,
          runId,
          workspace: session.workspace,
          conversationId: session.conversationId ?? session.sessionId,
          status: 'rejected',
          writerConversationId: rejection.writer.conversationId,
          writerRunId: rejection.writer.runId,
        })
        .catch((error: unknown) =>
          this.#onDiagnostic(
            'Failed to trace rejected workspace writer',
            error,
          ),
        )
    }
  }

  #handleWorkspaceWriterChanged(
    status: 'acquired' | 'released',
    owner: WorkspaceWriterOwner,
  ): void {
    const session =
      this.#sessions.get(owner.sessionId) ??
      this.#writerEventSessions.get(owner.runId)
    if (!session) return

    void session.logger
      .write({
        type: 'workspace.writer',
        sessionId: owner.sessionId,
        runId: owner.runId,
        workspace: owner.workspace,
        conversationId: owner.conversationId,
        status,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Failed to trace workspace writer change', error),
      )
    this.#emit(session, {
      type: 'workspace.writer.changed',
      workspace: owner.workspace,
      status,
      writerConversationId: owner.conversationId,
      writerSessionId: owner.sessionId,
      writerRunId: owner.runId,
    })
    if (status === 'released') {
      this.#writerEventSessions.delete(owner.runId)
    }
  }

  #workspaceConcurrencyContext(
    session: SessionState,
  ): WorkspaceConcurrencyContext {
    const writer = this.#workspaceAccess.writerFor(session.workspace)
    if (!writer) return { status: 'available' }

    if (writer.sessionId === session.sessionId) {
      return {
        status: 'writer',
        writerConversationId: writer.conversationId,
        writerRunId: writer.runId,
      }
    }

    return {
      status: 'readonly_locked',
      writerConversationId: writer.conversationId,
      writerRunId: writer.runId,
    }
  }

  /**
   * Resolves an open session or throws a typed IPC fault.
   */
  #requireSession(sessionId: SessionId): SessionState {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      ipcFault('NOT_FOUND', 'Session not found')
    }

    return session
  }

  /**
   * Emits a sequenced agent event through the shared event emitter.
   */
  #emit(session: SessionState, event: AgentEventDraft): void {
    this.#events.emitAgent(session, event)
  }

  /**
   * Applies trace retention while preserving trace files for active sessions.
   */
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
