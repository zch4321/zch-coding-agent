import path from 'node:path'
import {
  getDefaultModelSelection,
  getProviderConfig,
  type PermissionMode,
  type ProviderPublicConfig,
} from '../../shared/config'
import type {
  CallId,
  AgentExecutionId,
  MessageId,
  RunId,
  SessionId,
  TerminalId,
} from '../../shared/ids'
import type { ProviderToolDefinition } from '../providers/provider'
import type { MessageRecord } from '../../shared/message'
import { resolveManualContinuationTarget } from '../../shared/conversation-continuation'
import type { ModelSelection } from '../../shared/model-route'
import type { ResolvedModelRoute } from '../providers/model-route-resolver'
import type { RunContext } from '../../shared/context'
import type { TerminalInfo, TerminalSnapshot } from '../../shared/terminal'
import type {
  GoalState,
  PlanState,
  PlanStatus,
} from '../../shared/orchestration'
import type { SessionRecord } from '../../shared/session'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import type { SessionCommandResult } from '../../shared/domain-state-api'
import type { TraceCaptureStatus } from '../../shared/trace'
import type { LlmUsageRecord } from '../../shared/usage'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import { JsonlTraceLogger, NullTraceLogger } from '../logging/logger'
import { cleanupTraces } from '../logging/cleanup'
import type { PluginEventBus } from '../plugins/event-bus'
import { PathGuard } from '../safety/path-guard'
import {
  PermissionPipeline,
  type RememberApprovalInput,
} from '../permission/permission-pipeline'
import type { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import type { SkillsManager } from '../skills/manager'
import { id, ipcFault, toJsonValue } from './session-common'
import type {
  AgentEventDraft,
  HarnessRunMessage,
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
import { SessionOrchestratorMessages } from './session-orchestrator-messages'
import { createSessionTooling, type SessionTooling } from './session-tooling'
import type { McpManager } from '../mcp/mcp-manager'
import { SessionCompactCoordinator } from './session-compact-coordinator'
import { SessionInterjectionCoordinator } from './session-interjection-coordinator'
import { SessionOrchestrationPlanner } from './session-orchestration-planner'
import { SessionUserTurnPreparer } from './session-user-turn-preparer'
import { SessionRunController } from './session-run-controller'
import { updatePublicRunSnapshot } from './session-runtime-snapshot'
import {
  appendInitialPromptHarness,
  appendRuntimeContextIfChanged,
} from './prompt-harness'
import { SessionTraceController } from './session-trace-controller'
import { resolveSessionToolCatalog } from './session-tool-catalog'
import type {
  FrozenSubagentToolContext,
  FrozenSubagentRoutes,
  InternalSubagentRunOutcome,
} from '../subagent/contracts'
import { SubagentRuntimeError } from '../subagent/contracts'
import type { AgentToolAccess } from '../../shared/agent-execution'
import { hasSideEffects } from '../permission/policy-engine'

const RUN_CANCEL_GRACE_MS = 2_000
const CHILD_ORCHESTRATION_TOOL_IDS = new Set([
  'subagent_run',
  'swarm_run',
  'goal_get',
  'goal_complete',
  'goal_block',
  'plan_get',
  'plan_set',
  'plan_status',
  'plan_update',
])

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
  readonly #fileChangeExecution: SessionManagerOptions['fileChangeExecution']
  readonly #mcpManager: McpManager | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #traceLoggerFactory: NonNullable<
    SessionManagerOptions['traceLoggerFactory']
  >
  readonly #onDiagnostic: DiagnosticSink
  readonly #sessions = new Map<SessionId, SessionState>()
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
  readonly #permissionPipeline = new PermissionPipeline()
  readonly #executionState: SessionManagerOptions['executionState']

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
    this.#fileChangeExecution = options.fileChangeExecution
    this.#mcpManager = options.mcpManager
    this.#promptRegistry = options.promptRegistry
    this.#providerFactory = options.providerFactory
    this.#fetchImpl = options.fetchImpl
    this.#autoApproverFactory = options.autoApproverFactory
    this.#traceLoggerFactory =
      options.traceLoggerFactory ??
      ((sessionId) => JsonlTraceLogger.create(this.#traceDirectory, sessionId))
    this.#executionState = options.executionState
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.#events = new SessionEventEmitter({
      eventSink: options.eventSink,
      getSession: (sessionId) => this.#sessions.get(sessionId),
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
      getCommandShellSelection: () =>
        this.#configStore.getPublicConfig().executionEnvironment.commandShell,
      emit: (event) => this.#events.emitTerminal(event),
      requireSession: (sessionId) => this.#requireSession(sessionId),
    })
    const tooling = createSessionTooling({
      configStore: this.#configStore,
      terminals: this.#terminals,
      skillsManager: this.#skillsManager,
      mcpManager: options.mcpManager,
      subagentExecution: options.subagentExecution,
      swarmExecution: options.swarmExecution,
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
      providerFactory: this.#providerFactory,
      fetchImpl: this.#fetchImpl,
      orchestratorMessages: this.#orchestratorMessages,
      emit: (session, event) => this.#emit(session, event),
      setRunStatus: (session, run, status, error) =>
        this.#runs.setRunStatus(session, run, status, error),
      executionState: this.#executionState,
      historySource: options.historySource,
      operationalLog: options.operationalLog,
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
      orchestratorMessages: this.#orchestratorMessages,
      emit: (session, event) => this.#emit(session, event),
      swarmHostEnabled: options.swarmHostEnabled ?? false,
    })
    const providerTurns = new SessionProviderTurnRunner({
      configStore: this.#configStore,
      toolRegistry: this.#toolRegistry,
      pluginBus: this.#pluginBus,
      promptRegistry: options.promptRegistry,
      fetchImpl: this.#fetchImpl,
      providerFactory: this.#providerFactory,
      onDiagnostic: this.#onDiagnostic,
      operationalLog: options.operationalLog,
      emit: (session, event) => this.#emit(session, event),
    })
    const toolRunner = new SessionToolRunner({
      configStore: this.#configStore,
      pluginBus: this.#pluginBus,
      fileChangeExecution: this.#fileChangeExecution,
      promptRegistry: options.promptRegistry,
      fetchImpl: this.#fetchImpl,
      autoApproverFactory: this.#autoApproverFactory,
      permissionPipeline: this.#permissionPipeline,
      toolExecutor: this.#toolExecutor,
      approvals: this.#approvals,
      contextGate: this.#contextGate,
      mcpGateway: this.#mcpGateway,
      onDiagnostic: this.#onDiagnostic,
      operationalLog: options.operationalLog,
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
      executionState: this.#executionState,
      beforeRun: (session) => session.trace.beforeRun(),
      afterRun: (session) => session.trace.afterRun(),
      operationalLog: options.operationalLog,
      swarmHostEnabled: options.swarmHostEnabled ?? false,
    })
    this.#pluginBus?.setToolRegistrationPort(this.#toolRegistry)
  }

  /**
   * Creates a session bound to a guarded workspace and optional trace logger.
   *
   * Every session receives canonical initial harness messages immediately.
   */
  async createSession(input: {
    workspace: string
    mode: PermissionMode
    provider: string
    sessionId?: SessionId
    modelSelection?: ModelSelection
    goal?: GoalState
    plan?: PlanState
  }): Promise<SessionId> {
    return this.#createSession(input)
  }

  /** Creates an event-hidden Session for one Subagent execution. */
  async createInternalSession(input: {
    workspace: string
    mode: PermissionMode
    provider: string
    modelSelection: ModelSelection
    allowedToolIds: ReadonlySet<string>
    gitToolsEnabled: boolean
    providerSnapshot: ProviderPublicConfig
    sessionId?: SessionId
    execution: {
      executionId: AgentExecutionId
      parentSessionId: SessionId
      parentRunId: RunId
      parentCallId: CallId
      name: string
      createdAt: string
    }
  }): Promise<SessionId> {
    return this.#createSession(
      {
        workspace: input.workspace,
        mode: input.mode,
        provider: input.provider,
        modelSelection: input.modelSelection,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      {
        allowedToolIds: input.allowedToolIds,
        gitToolsEnabled: input.gitToolsEnabled,
        providerSnapshot: input.providerSnapshot,
        execution: input.execution,
      },
    )
  }

  async #createSession(
    input: {
      workspace: string
      mode: PermissionMode
      provider: string
      sessionId?: SessionId
      modelSelection?: ModelSelection
      goal?: GoalState
      plan?: PlanState
    },
    internal?: {
      allowedToolIds: ReadonlySet<string>
      gitToolsEnabled: boolean
      providerSnapshot: ProviderPublicConfig
      execution: NonNullable<SessionState['internalExecution']>
    },
  ): Promise<SessionId> {
    const configured = this.#configStore.getPublicConfig()
    const publicConfig = internal
      ? {
          ...configured,
          models: {
            ...configured.models,
            providers: getProviderConfig(configured, input.provider)
              ? configured.models.providers.map((candidate) =>
                  candidate.id === input.provider
                    ? structuredClone(internal.providerSnapshot)
                    : candidate,
                )
              : [
                  ...configured.models.providers,
                  structuredClone(internal.providerSnapshot),
                ],
          },
        }
      : configured

    if (
      !internal &&
      publicConfig.logging.trace.enabled &&
      publicConfig.privacy.traceNoticeAccepted?.version !== TRACE_NOTICE_VERSION
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Trace logging notice must be accepted before enabling full trace logs',
        { requiredVersion: TRACE_NOTICE_VERSION },
      )
    }

    const provider =
      getProviderConfig(publicConfig, input.provider) ??
      internal?.providerSnapshot
    if (!provider) {
      ipcFault(
        'PRECONDITION_FAILED',
        `Provider is not configured: ${input.provider}`,
      )
    }
    const guard = await PathGuard.create(input.workspace)
    if (!internal) {
      await this.#mcpManager?.activateWorkspace(guard.workspacePath)
    }
    const sessionId = input.sessionId ?? id<SessionId>('session')
    if (this.#sessions.has(sessionId)) {
      ipcFault('CONFLICT', 'Session already exists in the live registry')
    }
    const defaultSelection = getDefaultModelSelection(publicConfig)
    const initialModelSelection = structuredClone(
      input.modelSelection ?? {
        providerId: provider.id,
        model:
          provider.id === defaultSelection.providerId
            ? defaultSelection.model
            : provider.model,
        reasoning: defaultSelection.reasoning,
      },
    )
    const sessionRef: { current?: SessionState } = {}
    const trace = await SessionTraceController.create({
      sessionId,
      workspace: guard.workspacePath,
      model: () =>
        sessionRef.current?.modelSelection.model ?? initialModelSelection.model,
      mode: () => sessionRef.current?.mode ?? input.mode,
      configuredEnabled: internal ? false : publicConfig.logging.trace.enabled,
      factory: this.#traceLoggerFactory,
      onStatus: (capture) => {
        if (sessionRef.current) {
          this.#emitTraceCaptureStatus(sessionRef.current, capture)
        }
      },
      onDiagnostic: this.#onDiagnostic,
    })
    const session: SessionState = {
      sessionId,
      workspace: guard.workspacePath,
      mode: input.mode,
      provider: provider.id,
      modelSelection: initialModelSelection,
      modelSelectionPinned: input.modelSelection !== undefined,
      trace,
      logger: trace,
      history: [],
      nextMessageSeq: 1,
      eventSeq: 0,
      closed: false,
      visibility: internal ? 'internal' : 'public',
      ...(internal
        ? { internalExecution: structuredClone(internal.execution) }
        : {}),
      readOnlyWorkspace: Boolean(internal && input.mode === 'readonly'),
      gitToolsEnabled: internal?.gitToolsEnabled ?? true,
      ...(internal ? { allowedToolIds: new Set(internal.allowedToolIds) } : {}),
      clientRequests: new Map(),
      mcpDisclosures: new Map(),
      ...(input.goal ? { goal: structuredClone(input.goal) } : {}),
      ...(input.plan ? { plan: structuredClone(input.plan) } : {}),
    }
    sessionRef.current = session

    this.#sessions.set(sessionId, session)
    try {
      const toolCatalog = await resolveSessionToolCatalog({
        registry: this.#toolRegistry,
        allowedToolIds: session.allowedToolIds,
        subagentsEnabled: internal ? false : publicConfig.subagents.enabled,
        gitToolsEnabled: session.gitToolsEnabled,
      })
      await appendInitialPromptHarness(session, {
        workspace: session.workspace,
        mode: session.mode,
        config: publicConfig,
        providerId: provider.id,
        promptRegistry: this.#promptRegistry,
        skillSummary: this.#skillsManager?.summaryPrompt(),
        toolNames: toolCatalog.names,
      })
      this.#emitTraceCaptureStatus(session, trace.status())
      if (!internal) {
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
      }
    } catch (error) {
      this.#sessions.delete(sessionId)
      await session.trace.dispose().catch(() => undefined)
      throw error
    }

    return sessionId
  }

  /**
   * Loads a durable Session into the live registry without rebuilding its
   * initial harness. The next provider request is compiled from SQLite-backed
   * canonical history supplied by the caller.
   */
  async restoreSession(input: {
    record: SessionRecord
    workspace: string
    history: readonly MessageRecord[]
  }): Promise<SessionId> {
    const existing = this.#sessions.get(input.record.id)
    if (existing && !existing.closed) return existing.sessionId
    if (input.record.lifecycle !== 'active') {
      ipcFault('PRECONDITION_FAILED', 'Archived Session cannot be loaded')
    }
    const publicConfig = this.#configStore.getPublicConfig()
    const provider = getProviderConfig(
      publicConfig,
      input.record.modelSelection.providerId,
    )
    if (!provider) {
      ipcFault(
        'PRECONDITION_FAILED',
        `Provider is not configured: ${input.record.modelSelection.providerId}`,
      )
    }
    const guard = await PathGuard.create(input.workspace)
    await this.#mcpManager?.activateWorkspace(guard.workspacePath)
    const sessionRef: { current?: SessionState } = {}
    const trace = await SessionTraceController.create({
      sessionId: input.record.id,
      workspace: guard.workspacePath,
      model: () =>
        sessionRef.current?.modelSelection.model ??
        input.record.modelSelection.model,
      mode: () => sessionRef.current?.mode ?? input.record.permissionMode,
      configuredEnabled: publicConfig.logging.trace.enabled,
      factory: this.#traceLoggerFactory,
      onStatus: (capture) => {
        if (sessionRef.current) {
          this.#emitTraceCaptureStatus(sessionRef.current, capture)
        }
      },
      onDiagnostic: this.#onDiagnostic,
    })
    const session: SessionState = {
      sessionId: input.record.id,
      workspace: guard.workspacePath,
      mode: input.record.permissionMode,
      provider: input.record.modelSelection.providerId,
      modelSelection: structuredClone(input.record.modelSelection),
      modelSelectionPinned: true,
      trace,
      logger: trace,
      history: structuredClone([...input.history]),
      nextMessageSeq: input.record.lastSeq + 1,
      goal: input.record.goal ? structuredClone(input.record.goal) : undefined,
      plan: input.record.plan ? structuredClone(input.record.plan) : undefined,
      eventSeq: 0,
      closed: false,
      visibility: 'public',
      readOnlyWorkspace: false,
      gitToolsEnabled: true,
      clientRequests: new Map(),
      mcpDisclosures: new Map(),
    }
    sessionRef.current = session
    this.#sessions.set(session.sessionId, session)
    this.#emitTraceCaptureStatus(session, trace.status())
    return session.sessionId
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
    reason?: 'active_run'
  }> {
    const session = this.#sessions.get(sessionId)

    if (!session || session.closed) {
      return { accepted: false }
    }

    if (session.activeRun || session.mutationInProgress) {
      return { accepted: false, reason: 'active_run' }
    }

    const previousMode = session.mode
    const previousHistory = structuredClone(session.history)
    const previousNextSeq = session.nextMessageSeq
    session.mutationInProgress = true
    try {
      await session.logger.write({
        type: 'session.mode',
        sessionId,
        mode,
      })
      session.mode = mode
      const toolCatalog = await resolveSessionToolCatalog({
        registry: this.#toolRegistry,
        subagentsEnabled: this.#configStore.getPublicConfig().subagents.enabled,
        gitToolsEnabled: session.gitToolsEnabled,
      })
      await appendRuntimeContextIfChanged(session, {
        workspace: session.workspace,
        mode: session.mode,
        config: this.#configStore.getPublicConfig(),
        providerId: session.provider,
        promptRegistry: this.#promptRegistry,
        reason: 'permission_mode_changed',
        toolNames: toolCatalog.names,
      })
      await this.#executionState?.commit(session, { reason: 'metadata' })
    } catch (error) {
      session.mode = previousMode
      session.history = previousHistory
      session.nextMessageSeq = previousNextSeq
      throw error
    } finally {
      session.mutationInProgress = false
    }
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
  }): Promise<SessionCommandResult> {
    const session = this.#sessions.get(input.sessionId)

    if (
      !session ||
      session.closed ||
      session.activeRun ||
      session.mutationInProgress ||
      !session.plan
    ) {
      ipcFault(
        'PRECONDITION_FAILED',
        'Plan status cannot be changed in the current Session state',
      )
    }

    const openItems = session.plan.items.filter(
      (item) => item.status !== 'completed' && item.status !== 'cancelled',
    )

    if (input.status === 'completed' && openItems.length > 0) {
      ipcFault(
        'PRECONDITION_FAILED',
        'A plan with open items cannot be completed',
      )
    }

    const previousPlan = structuredClone(session.plan)
    const previousStatus = session.plan.status ?? 'active'
    session.mutationInProgress = true
    try {
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
      const result = await this.#executionState?.commit(session, {
        reason: 'metadata',
      })
      if (!result) {
        throw new Error('Plan status mutation requires durable execution state')
      }
      return result
    } catch (error) {
      session.plan = previousPlan
      throw error
    } finally {
      session.mutationInProgress = false
    }
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
    const trace = session.trace

    if (session.activeRun) {
      const completed = await this.#runs.cancelForSessionClose(
        session,
        RUN_CANCEL_GRACE_MS,
      )

      if (!completed) {
        session.logger = new NullTraceLogger()
        this.#onDiagnostic(
          `Run ${session.activeRun.runId} did not stop within the cancellation grace period`,
        )
      }
    }

    this.#terminals.closeSession(sessionId)

    if (session.visibility === 'public') {
      await this.#pluginBus
        ?.emit('onSessionEnd', {
          version: 1,
          sessionId,
          reason: 'closed',
        })
        .catch((error: unknown) =>
          this.#onDiagnostic('Plugin onSessionEnd failed', error),
        )
    }
    await trace.dispose()
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
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    return this.#runs.start(
      session,
      input.clientRequestId,
      input.message,
      input.context,
    )
  }

  /** Returns the exact routes frozen by an active parent Run. */
  frozenSubagentRoutes(
    sessionId: SessionId,
    runId: RunId,
  ): FrozenSubagentRoutes {
    const session = this.#sessions.get(sessionId)
    const run = session?.activeRun
    if (
      !session ||
      session.closed ||
      session.visibility !== 'public' ||
      !run ||
      run.runId !== runId
    ) {
      throw new SubagentRuntimeError(
        'SUBAGENT_PARENT_NOT_ACTIVE',
        'The parent Run is no longer active',
      )
    }
    if (!run.subagentsEnabled) {
      throw new SubagentRuntimeError(
        'SUBAGENTS_DISABLED',
        'Subagents were disabled when this Run started',
      )
    }
    if (!run.routes) {
      throw new SubagentRuntimeError(
        'SUBAGENT_ROUTE_UNAVAILABLE',
        'The parent Run has not frozen its model routes',
      )
    }
    return structuredClone({
      main: run.routes.main,
      compression: run.routes.compression,
    })
  }

  /** Resolves delegated Tool access without allowing a Child to exceed its parent Run. */
  frozenSubagentToolContext(
    sessionId: SessionId,
    runId: RunId,
    toolAccess: AgentToolAccess,
  ): FrozenSubagentToolContext {
    this.frozenSubagentRoutes(sessionId, runId)
    const session = this.#sessions.get(sessionId)!
    const run = session.activeRun!
    const permissionMode = toolAccess === 'readonly' ? 'readonly' : session.mode
    const parentCatalog = resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      gitToolsEnabled: session.gitToolsEnabled,
    })
    const allowedToolIds = new Set(
      parentCatalog.names.filter((toolId) => {
        if (CHILD_ORCHESTRATION_TOOL_IDS.has(toolId)) return false
        const definition = this.#toolRegistry.get(toolId)
        return Boolean(
          definition &&
          (permissionMode !== 'readonly' || !hasSideEffects(definition)),
        )
      }),
    )
    return {
      permissionMode,
      allowedToolIds,
      gitToolsEnabled: session.gitToolsEnabled,
    }
  }

  /** Returns the optional slash-command goal for a live parent Swarm Run. */
  frozenSwarmContext(sessionId: SessionId, runId: RunId): { goal?: string } {
    const session = this.#sessions.get(sessionId)
    const run = session?.activeRun
    if (
      !session ||
      session.closed ||
      session.visibility !== 'public' ||
      !run ||
      run.runId !== runId ||
      !run.swarmToolConfig
    ) {
      throw new SubagentRuntimeError(
        'SWARM_NOT_AVAILABLE',
        'Swarm is not available in this Run',
      )
    }
    return structuredClone(run.swarmToolConfig)
  }

  /** Starts one internal Run with a plain user input and exact inherited routes. */
  startInternalRun(input: {
    sessionId: SessionId
    task: string
    context?: { content: string; source: string }
    clientRequestId: string
    routes: FrozenSubagentRoutes
  }): {
    runId: RunId
    completion: Promise<InternalSubagentRunOutcome>
  } {
    const session = this.#requireSession(input.sessionId)
    if (session.visibility !== 'internal') {
      throw new SubagentRuntimeError(
        'SUBAGENT_SESSION_INVALID',
        'Internal Run requires a hidden Subagent Session',
      )
    }
    const runId = this.#runs.start(
      session,
      input.clientRequestId,
      input.task,
      undefined,
      undefined,
      undefined,
      {
        routes: input.routes,
        directUserInput: true,
        ...(input.context ? { directContext: input.context } : {}),
        subagentsEnabled: false,
        allowedToolIds: session.allowedToolIds,
        skipProviderPreconditions: true,
      },
    )
    const run = session.activeRun
    if (!run || run.runId !== runId) {
      throw new SubagentRuntimeError(
        'SUBAGENT_START_FAILED',
        'Internal Run did not enter the active registry',
      )
    }
    return {
      runId,
      completion: run.done.then(() => {
        const assistant = [...session.history]
          .reverse()
          .find(
            (record) =>
              record.kind === 'assistant_turn' &&
              record.turnId === run.rootUserMessageId,
          )
        const response =
          assistant?.kind === 'assistant_turn'
            ? assistant.parts
                .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                .join('\n')
                .trim()
            : ''
        const finishReason =
          assistant?.kind === 'assistant_turn'
            ? assistant.metadata?.finishReason
            : undefined
        return {
          status: run.status,
          ...(response ? { response } : {}),
          ...(finishReason ? { finishReason } : {}),
          usage: structuredClone(run.usageRecords),
          ...(run.failure ? { error: structuredClone(run.failure) } : {}),
        }
      }),
    }
  }

  /** Attributes child usage to its active parent Run without exposing child events. */
  async recordSubagentUsage(input: {
    sessionId: SessionId
    runId: RunId
    callId: CallId
    usage: readonly LlmUsageRecord[]
  }): Promise<void> {
    const session = this.#sessions.get(input.sessionId)
    const run = session?.activeRun
    if (!session || !run || run.runId !== input.runId) return
    for (const record of input.usage) {
      const usage = { ...structuredClone(record), scope: 'subagent' as const }
      run.usageRecords.push(usage)
      await session.logger.write({
        type: 'llm.usage',
        sessionId: input.sessionId,
        runId: input.runId,
        callId: input.callId,
        usage,
      })
      this.#emit(session, {
        type: 'llm.usage',
        sessionId: input.sessionId,
        runId: input.runId,
        callId: input.callId,
        usage,
      })
    }
  }

  /**
   * Re-runs the active branch ending at an existing original user message.
   * No new user record is appended.
   */
  retryRun(input: {
    sessionId: SessionId
    userMessageId: MessageId
    clientRequestId: string
  }): RunId {
    const session = this.#requireSession(input.sessionId)
    return this.#runs.start(
      session,
      input.clientRequestId,
      undefined,
      undefined,
      undefined,
      input.userMessageId,
    )
  }

  /** Continues an interrupted turn without appending another user message. */
  continueRun(input: { sessionId: SessionId; clientRequestId: string }): RunId {
    const session = this.#requireSession(input.sessionId)
    const target = resolveManualContinuationTarget(session.history)
    if (!target) {
      ipcFault(
        'PRECONDITION_FAILED',
        'The Session history does not end at a continuable turn',
      )
    }
    return this.#runs.start(
      session,
      input.clientRequestId,
      undefined,
      undefined,
      undefined,
      target.rootUserMessageId,
    )
  }

  /** Starts a prompt-harness run for an existing Session and client request. */
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
    return new Set(
      [...this.#sessions.values()].flatMap((session) =>
        session.trace.traceId ? [session.trace.traceId] : [],
      ),
    )
  }

  /** Returns the live trace capture status for one loaded Session. */
  traceCaptureStatus(sessionId: SessionId): TraceCaptureStatus | undefined {
    const session = this.#sessions.get(sessionId)
    return session && !session.closed ? session.trace.status() : undefined
  }

  /**
   * Applies a saved logging setting to every live Session and returns bounded
   * warnings for captures that could not be created.
   */
  async reconfigureTraceLogging(enabled: boolean): Promise<string[]> {
    const sessions = [...this.#sessions.values()]
    const statuses = await Promise.all(
      sessions.map(async (session) => {
        if (session.closed) return
        return session.trace.configure(enabled)
      }),
    )
    return statuses
      .flatMap((status, index) =>
        status?.warning
          ? [`${sessions[index]!.sessionId}: ${status.warning}`.slice(0, 1_024)]
          : [],
      )
      .slice(0, 512)
  }

  /** Reports whether a Session is loaded and open in the manager. */
  hasLiveSession(sessionId: SessionId): boolean {
    const session = this.#sessions.get(sessionId)
    return Boolean(session && !session.closed)
  }

  /** Reports whether a Session currently owns an active run. */
  hasActiveRun(sessionId: SessionId): boolean {
    return Boolean(this.#sessions.get(sessionId)?.activeRun)
  }

  /** Reports whether a Session is committing an idle metadata mutation. */
  hasMutationInProgress(sessionId: SessionId): boolean {
    const session = this.#sessions.get(sessionId)
    return Boolean(session && !session.closed && session.mutationInProgress)
  }

  /** Reports whether an active run still has pending side effects. */
  hasUnsettledSideEffects(sessionId: SessionId): boolean {
    return Boolean(
      this.#sessions.get(sessionId)?.activeRun?.pendingSideEffects.size,
    )
  }

  /** Reports whether a Session currently owns any open terminals. */
  hasOpenTerminals(sessionId: SessionId): boolean {
    const session = this.#sessions.get(sessionId)
    if (!session || session.closed) return false
    return this.#terminals.list(sessionId).length > 0
  }

  /** Returns a cloned public snapshot for a Session's active run. */
  activeRunSnapshot(sessionId: SessionId): ActiveRunPublicSnapshot | undefined {
    const snapshot = this.#sessions.get(sessionId)?.activeRun?.publicSnapshot
    return snapshot ? structuredClone(snapshot) : undefined
  }

  /** Returns the frozen main route while the identified Run is completing. */
  completedRunMainRoute(
    sessionId: SessionId,
    runId: RunId,
  ): ResolvedModelRoute | undefined {
    const session = this.#sessions.get(sessionId)
    const run = session?.activeRun
    if (
      !session ||
      session.closed ||
      session.visibility !== 'public' ||
      !run ||
      run.runId !== runId ||
      run.status !== 'completed' ||
      !run.routes
    ) {
      return undefined
    }
    return structuredClone(run.routes.main)
  }

  /** Applies committed Session metadata and history to live state and its durable binding. */
  applyDurableSessionRecord(record: SessionRecord): void {
    const session = this.#sessions.get(record.id)
    if (!session || session.closed) return
    if (session.activeRun) {
      ipcFault(
        'CONFLICT',
        'Session metadata cannot change during an active run',
      )
    }
    session.mode = record.permissionMode
    session.provider = record.modelSelection.providerId
    session.modelSelection = structuredClone(record.modelSelection)
    session.modelSelectionPinned = true
    session.goal = record.goal ? structuredClone(record.goal) : undefined
    session.plan = record.plan ? structuredClone(record.plan) : undefined
  }

  /** Requests cancellation of a specific active run. */
  interruptRun(sessionId: SessionId, runId: RunId): boolean {
    const session = this.#requireSession(sessionId)
    return this.#runs.interrupt(session, runId)
  }

  /** Returns cloned tool definitions in the shape exposed to the provider. */
  providerToolDefinitions(): ProviderToolDefinition[] {
    return structuredClone(this.#toolRegistry.providerDefinitions())
  }

  /** Returns registered tool IDs in stable sorted order. */
  toolNames(): string[] {
    return this.#toolRegistry
      .list()
      .map((tool) => tool.id)
      .sort()
  }

  /** Waits for the specified active run to settle when it is still current. */
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

    if (
      run.status === 'cancelling' ||
      run.status === 'completed' ||
      run.status === 'cancelled' ||
      run.status === 'failed' ||
      !run.acceptingInterjections
    ) {
      ipcFault('CONFLICT', 'The active run no longer accepts interjections')
    }

    return this.#interjections.queue(session, run, {
      message: input.message,
      clientRequestId: input.clientRequestId,
    })
  }

  /** Resolves a pending approval decision for the matching Session, run, and call. */
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

  /** Resolves an approval owned by an active internal Child execution. */
  decideAgentExecutionApproval(input: {
    parentSessionId: SessionId
    executionId: AgentExecutionId
    callId: CallId
    decision: 'allow' | 'deny'
    remember?: RememberApprovalInput
  }): boolean {
    for (const session of this.#sessions.values()) {
      const execution = session.internalExecution
      const run = session.activeRun
      if (
        session.closed ||
        !execution ||
        execution.parentSessionId !== input.parentSessionId ||
        execution.executionId !== input.executionId ||
        !run
      ) {
        continue
      }
      return this.#approvals.decide(session, {
        sessionId: session.sessionId,
        runId: run.runId,
        callId: input.callId,
        decision: input.decision,
        remember: input.remember,
      })
    }
    return false
  }

  /** Opens a terminal owned by the specified Session. */
  async openTerminal(input: {
    sessionId: SessionId
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    return this.#terminals.open(input)
  }

  /** Lists terminals owned by a Session. */
  listTerminals(sessionId: SessionId): TerminalInfo[] {
    return this.#terminals.list(sessionId)
  }

  /** Writes input to a Session-owned terminal. */
  sendTerminalInput(
    sessionId: SessionId,
    terminalId: TerminalId,
    data: string,
  ): boolean {
    return this.#terminals.write(sessionId, terminalId, data)
  }

  /** Changes the dimensions of a Session-owned terminal. */
  resizeTerminal(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    return this.#terminals.resize(sessionId, terminalId, cols, rows)
  }

  /** Closes a Session-owned terminal. */
  closeTerminal(sessionId: SessionId, terminalId: TerminalId): boolean {
    return this.#terminals.close(sessionId, terminalId)
  }

  /** Returns scrollback and process state for a Session-owned terminal. */
  terminalSnapshot(
    sessionId: SessionId,
    terminalId: TerminalId,
  ): TerminalSnapshot {
    return this.#terminals.snapshot(sessionId, terminalId)
  }

  /** Closes every Session and its terminal resources. */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((idValue) => this.closeSession(idValue)),
    )
    await this.#terminals.dispose()
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
    const run =
      'runId' in event && session.activeRun?.runId === event.runId
        ? session.activeRun
        : undefined
    if (run) updatePublicRunSnapshot(run, event)
    this.#events.emitAgent(session, event)
  }

  #emitTraceCaptureStatus(
    session: SessionState,
    capture: TraceCaptureStatus,
  ): void {
    this.#emit(session, {
      type: 'trace.capture.changed',
      sessionId: session.sessionId,
      capture,
    })
  }

  /**
   * Applies trace retention while preserving trace files for active sessions.
   */
  async #cleanupTraces(): Promise<void> {
    const config = this.#configStore.getPublicConfig()
    const activeFiles = new Set(
      [...this.activeTraceIds()].map((traceId) =>
        path.resolve(this.#traceDirectory, `${traceId}.jsonl`),
      ),
    )

    await cleanupTraces(this.#traceDirectory, {
      retentionDays: config.logging.trace.retentionDays,
      maxTotalBytes: config.logging.trace.maxTotalBytes,
      activeFiles,
      onDiagnostic: this.#onDiagnostic,
    })
  }
}
