import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { PermissionMode, PublicConfig } from '../../shared/config'
import { IPC_VERSION } from '../../shared/channels'
import type {
  AgentEvent,
  PolicySignal,
  RunStatus,
  TerminalEvent,
  ToolResultEnvelope,
} from '../../shared/agent-events'
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
import { IpcFault } from '../ipc'
import { sendAgentEvent, sendTerminalEvent } from '../ipc/event-sink'
import {
  JsonlTraceLogger,
  NullTraceLogger,
  type TraceLogger,
} from '../logging/logger'
import { cleanupTraces } from '../logging/cleanup'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ToolCall, ToolResult } from '../tools/types'
import { ContextIngressFilter } from './context-ingress'
import { DeepSeekProvider } from './deepseek-provider'
import { PathGuard } from './path-guard'
import type {
  LLMProvider,
  ProviderAssistantTurn,
  ProviderEvent,
  ProviderMessage,
  ProviderRequestSnapshot,
} from './provider'
import { registerReadOnlyTools } from './readonly-tools'
import { registerFileTools } from './file-tools'
import { registerProcessTools } from './process-tools'
import {
  PermissionPipeline,
  type ApprovalRequest,
  type HumanApprovalDecision,
  type RememberApprovalInput,
} from './permission-pipeline'
import { ProviderAutoApprover, type AutoApprover } from './auto-approver'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import { TerminalPool, type TerminalEventDraft } from '../terminal/pool'
import { registerTerminalTools } from './terminal-tools'
import {
  boundToolResultForContext,
  ContextBudgetError,
  estimateJsonTokens,
  selectContextMessages,
} from './context-budget'
import { resolveModelProfiles } from './model-catalog'
import type { SkillsManager } from '../skills/manager'
import { registerSkillTools } from './skill-tools'

const SYSTEM_PROMPT =
  'You are My Coding Agent. Work only inside the selected workspace and use the provided tools. Explain the reason for every tool call. Never claim a file changed unless the tool result confirms it.'
const RUN_CANCEL_GRACE_MS = 2_000

type AgentEventDraft = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never

type TerminalEventDraftEnvelope = TerminalEvent extends infer Event
  ? Event extends TerminalEvent
    ? Omit<Event, 'schemaVersion' | 'seq' | 'ts'>
    : never
  : never

export interface SessionManagerOptions {
  configStore: ConfigStore
  traceDirectory: string
  getWebContents: () => WebContents | undefined
  pluginBus?: PluginEventBus
  skillsManager?: SkillsManager
  providerFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => LLMProvider
  autoApproverFactory?: (options: {
    config: PublicConfig
    apiKey: string
  }) => AutoApprover
  onDiagnostic?: (message: string, error?: unknown) => void
}

interface PendingApproval {
  callId: CallId
  expiresAt: number
  resolve: (decision: HumanApprovalDecision) => void
}

interface ActiveRun {
  runId: RunId
  clientRequestId: string
  controller: AbortController
  done: Promise<void>
  status: RunStatus
  toolTokensUsed: number
  pendingApproval?: PendingApproval
}

interface SessionState {
  sessionId: SessionId
  workspace: string
  mode: PermissionMode
  provider: 'deepseek'
  logger: TraceLogger
  history: ProviderMessage[]
  systemPromptOverride?: string
  providerRequestOverride?: JsonValue
  forkedFromEventId?: EventId
  eventSeq: number
  closed: boolean
  activeRun?: ActiveRun
  clientRequests: Map<string, RunId>
}

function id<Kind extends SessionId | RunId | CallId>(prefix: string): Kind {
  return `${prefix}-${randomUUID()}` as Kind
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function ipcFault(
  code:
    | 'PRECONDITION_FAILED'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'CANCELLED'
    | 'INTERNAL_ERROR',
  message: string,
  details?: JsonValue,
): never {
  throw new IpcFault({ code, message, details })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toolResultForProvider(result: ToolResult): string {
  return JSON.stringify(result)
}

function normalizeToolResult(result: ToolResult): ToolResultEnvelope {
  return result as ToolResultEnvelope
}

function toolFailure(error: unknown, signal: AbortSignal): ToolResult {
  if (signal.aborted) {
    return { status: 'cancelled', message: 'The run was cancelled' }
  }

  return {
    status: 'error',
    code:
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'TOOL_FAILED',
    message:
      error instanceof Error ? error.message : 'Tool failed unexpectedly',
    retryable: false,
  }
}

function finalStatusFromError(error: unknown, signal: AbortSignal): RunStatus {
  if (signal.aborted) {
    return 'cancelled'
  }

  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'AbortError'
  ) {
    return 'cancelled'
  }

  return 'failed'
}

function modelPromptBudget(config: PublicConfig, tools: JsonValue[]): number {
  const model = resolveModelProfiles(config).find(
    (candidate) => candidate.id === config.providers.deepseek.model,
  )
  const contextWindow =
    model?.contextWindowTokens ?? config.limits.maxContextTokens
  const outputReserve = model?.maxOutputTokens
    ? Math.min(model.maxOutputTokens, Math.floor(contextWindow * 0.4))
    : Math.min(8_192, Math.floor(contextWindow * 0.2))
  const toolSchemaTokens = estimateJsonTokens(
    tools,
    config.limits.tokenEstimation,
  )
  const budget = contextWindow - outputReserve - toolSchemaTokens

  if (budget < 1_024) {
    throw new ContextBudgetError(
      'Model output reserve and tool schemas leave no usable prompt budget',
    )
  }

  return budget
}

function contextMessages(
  history: ProviderMessage[],
  config: PublicConfig,
  tools: JsonValue[],
  skillPrompt = '',
): ProviderMessage[] {
  const system: ProviderMessage = {
    role: 'system',
    content: skillPrompt ? `${SYSTEM_PROMPT}\n\n${skillPrompt}` : SYSTEM_PROMPT,
  }

  return selectContextMessages({
    system,
    history,
    maxPromptTokens: modelPromptBudget(config, tools),
    estimation: config.limits.tokenEstimation,
  })
}

export class SessionManager {
  readonly #configStore: ConfigStore
  readonly #traceDirectory: string
  readonly #getWebContents: () => WebContents | undefined
  readonly #pluginBus: PluginEventBus | undefined
  readonly #skillsManager: SkillsManager | undefined
  readonly #providerFactory: SessionManagerOptions['providerFactory']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #sessions = new Map<SessionId, SessionState>()
  readonly #toolRegistry = new ToolRegistry()
  readonly #toolExecutor: ToolExecutor
  readonly #terminalPool: TerminalPool
  readonly #permissionPipeline = new PermissionPipeline()
  readonly #ingressFilter = new ContextIngressFilter()

  constructor(options: SessionManagerOptions) {
    this.#configStore = options.configStore
    this.#traceDirectory = options.traceDirectory
    this.#getWebContents = options.getWebContents
    this.#pluginBus = options.pluginBus
    this.#skillsManager = options.skillsManager
    this.#providerFactory = options.providerFactory
    this.#autoApproverFactory = options.autoApproverFactory
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.#terminalPool = new TerminalPool({
      getScrollbackBytes: () =>
        this.#configStore.getPublicConfig().limits.terminalScrollbackBytes,
      emit: (event) => this.#emitTerminal(event),
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
      this.#terminalPool,
      () => this.#configStore.getPublicConfig().limits.maxToolOutputBytes,
    )
    if (this.#skillsManager) {
      registerSkillTools(this.#toolRegistry, this.#skillsManager)
    }
    this.#toolExecutor = new ToolExecutor(this.#toolRegistry)
    this.#pluginBus?.setToolRegistrationPort(this.#toolRegistry)
  }

  async createSession(input: {
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

    this.#terminalPool.closeSession(sessionId)

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
    const run = session.activeRun

    if (
      !run ||
      run.runId !== input.runId ||
      run.pendingApproval?.callId !== input.callId ||
      run.pendingApproval.expiresAt <= Date.now()
    ) {
      return false
    }

    const pending = run.pendingApproval
    run.pendingApproval = undefined
    pending.resolve({
      decision: input.decision,
      remember: input.decision === 'allow' ? input.remember : undefined,
    })
    return true
  }

  async openTerminal(input: {
    sessionId: SessionId
    cwd?: string
    cols?: number
    rows?: number
  }): Promise<TerminalInfo> {
    const session = this.#requireSession(input.sessionId)
    return this.#terminalPool.open({
      sessionId: session.sessionId,
      workspace: session.workspace,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
    })
  }

  listTerminals(sessionId: SessionId): TerminalInfo[] {
    this.#requireSession(sessionId)
    return this.#terminalPool.list(sessionId)
  }

  sendTerminalInput(
    sessionId: SessionId,
    terminalId: TerminalId,
    data: string,
  ): boolean {
    this.#requireSession(sessionId)
    return this.#terminalPool.write(sessionId, terminalId, data)
  }

  resizeTerminal(
    sessionId: SessionId,
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): boolean {
    this.#requireSession(sessionId)
    return this.#terminalPool.resize(sessionId, terminalId, cols, rows)
  }

  closeTerminal(sessionId: SessionId, terminalId: TerminalId): boolean {
    this.#requireSession(sessionId)
    return this.#terminalPool.close(sessionId, terminalId)
  }

  terminalSnapshot(
    sessionId: SessionId,
    terminalId: TerminalId,
  ): TerminalSnapshot {
    this.#requireSession(sessionId)
    return this.#terminalPool.snapshot(sessionId, terminalId)
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((idValue) => this.closeSession(idValue)),
    )
    this.#terminalPool.dispose()
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

        const completed = await this.#callProvider(session, run)

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
        await this.#executeToolCalls(session, run, completed.toolCalls)
      }

      throw new Error('Run exceeded maxStepsPerRun')
    } catch (error) {
      const status = finalStatusFromError(error, signal)
      await this.#finishRun(session, run, status, error)
    }
  }

  async #callProvider(
    session: SessionState,
    run: ActiveRun,
  ): Promise<{
    turn: ProviderAssistantTurn
    toolCalls: ToolCall[]
    text: string
    reasoning: string
  }> {
    this.#setRunStatus(session, run, 'calling_llm')
    const config = this.#configStore.getPublicConfig()
    const apiKey = await this.#configStore.getDeepSeekApiKey()

    if (!apiKey) {
      ipcFault('PRECONDITION_FAILED', 'DeepSeek credential is not available')
    }

    const tools = this.#toolRegistry.providerDefinitions()
    let messages = session.systemPromptOverride
      ? selectContextMessages({
          system: { role: 'system', content: session.systemPromptOverride },
          history: session.history,
          maxPromptTokens: modelPromptBudget(config, tools),
          estimation: config.limits.tokenEstimation,
        })
      : contextMessages(
          session.history,
          config,
          tools,
          this.#skillsManager?.summaryPrompt() ?? '',
        )
    const hookResult = await this.#pluginBus?.emit('beforeLLMCall', {
      version: 1,
      sessionId: session.sessionId,
      runId: run.runId,
      messages: toJsonValue(messages) as JsonValue[],
      params: {
        provider: 'deepseek',
        model: config.providers.deepseek.model,
      },
    })

    for (const patch of hookResult?.patches ?? []) {
      if (patch.messages) {
        messages = patch.messages as unknown as ProviderMessage[]
      }
    }

    if (
      estimateJsonTokens(messages, config.limits.tokenEstimation) >
      modelPromptBudget(config, tools)
    ) {
      throw new ContextBudgetError(
        'A beforeLLMCall hook exceeded the model context budget',
      )
    }

    const provider =
      this.#providerFactory?.({ config, apiKey }) ??
      new DeepSeekProvider({
        baseURL: config.providers.deepseek.baseURL,
        model: config.providers.deepseek.model,
        reasoning: config.providers.deepseek.reasoning,
        apiKey,
      })
    const llmCallId = id<CallId>('llm')
    let text = ''
    let reasoning = ''
    let completed: Extract<ProviderEvent, { type: 'completed' }> | undefined

    const onRequest = async (snapshot: ProviderRequestSnapshot) => {
      await session.logger.write({
        type: 'llm.request',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: llmCallId,
        normalizedMessages: snapshot.normalizedMessages,
        providerRequest: snapshot.providerRequest,
        requestBytes: snapshot.requestBytes,
        prefixHash: snapshot.prefixHash,
        prefixFingerprints: snapshot.prefixFingerprints,
      })
    }

    const providerRequestOverride = session.providerRequestOverride
    session.providerRequestOverride = undefined

    for await (const event of provider.streamChat({
      messages,
      tools,
      providerRequestOverride,
      signal: run.controller.signal,
      onRequest,
    })) {
      await this.#recordProviderEvent(session, run, llmCallId, event)

      if (event.type === 'text.delta') {
        text += event.delta
        this.#emit(session, {
          type: 'assistant.text.delta',
          sessionId: session.sessionId,
          runId: run.runId,
          delta: event.delta,
        })
      } else if (event.type === 'reasoning.delta') {
        if (config.providers.deepseek.reasoning !== 'off') {
          reasoning += event.delta
          this.#emit(session, {
            type: 'assistant.reasoning.delta',
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
      throw new Error('Provider stream ended without completion')
    }

    await session.logger.write({
      type: 'llm.response',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: llmCallId,
      rawResponse: completed.rawResponse,
      normalizedTurn: toJsonValue(completed.turn),
      providerState: completed.providerState,
      usage: completed.usage,
      timing: completed.timing,
    })
    await this.#pluginBus
      ?.emit('afterLLMCall', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        response: completed.rawResponse,
        usage: completed.usage,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin afterLLMCall failed', error),
      )

    return {
      turn: completed.turn,
      toolCalls: completed.toolCalls,
      text,
      reasoning,
    }
  }

  async #recordProviderEvent(
    session: SessionState,
    run: ActiveRun,
    callId: CallId,
    event: ProviderEvent,
  ): Promise<void> {
    if (event.type === 'completed') {
      return
    }

    await session.logger.write({
      type: 'llm.stream',
      sessionId: session.sessionId,
      runId: run.runId,
      callId,
      providerEvent: toJsonValue(event),
      elapsedMs: 0,
    })
  }

  async #executeToolCalls(
    session: SessionState,
    run: ActiveRun,
    toolCalls: ToolCall[],
  ): Promise<void> {
    this.#setRunStatus(session, run, 'running_tools')

    for (const call of toolCalls) {
      this.#emit(session, {
        type: 'tool.proposed',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: call.id,
        tool: call.toolId,
        args: call.args,
        reason: call.reason,
      })

      let result: ToolResult
      let approvedBy = 'none'
      let policySignals: JsonValue[] = []
      let diffHash: string | undefined
      const startedAt = performance.now()
      try {
        if (run.controller.signal.aborted) {
          result = { status: 'cancelled', message: 'The run was cancelled' }
        } else {
          const inspected = this.#toolExecutor.inspectCall(call)

          if (!inspected.ok) {
            result = inspected.result
          } else {
            const config = this.#configStore.getPublicConfig()
            const apiKey = await this.#configStore.getDeepSeekApiKey()
            const autoApprover =
              session.mode === 'auto' && apiKey
                ? (this.#autoApproverFactory?.({ config, apiKey }) ??
                  new ProviderAutoApprover(
                    new DeepSeekProvider({
                      baseURL: config.providers.deepseek.baseURL,
                      model: config.approval.approverModel,
                      reasoning: 'off',
                      apiKey,
                    }),
                  ))
                : undefined
            const authorization = await this.#permissionPipeline.authorize({
              sessionId: session.sessionId,
              runId: run.runId,
              workspace: session.workspace,
              mode: session.mode,
              call,
              definition: inspected.definition,
              config,
              signal: run.controller.signal,
              autoApprover,
              beforeToolCall: (currentRisk) =>
                this.#pluginBus?.emit('beforeToolCall', {
                  version: 1,
                  sessionId: session.sessionId,
                  runId: run.runId,
                  call,
                  currentRisk,
                }) ?? Promise.resolve(undefined),
              requestHumanApproval: (request) =>
                this.#requestToolApproval(session, run, request),
            })
            policySignals = toJsonValue(
              authorization.policySignals,
            ) as JsonValue[]

            if (authorization.autoDecision) {
              await session.logger.write({
                type: 'approval',
                sessionId: session.sessionId,
                runId: run.runId,
                callId: call.id,
                policySignals: toJsonValue(
                  authorization.policySignals,
                ) as JsonValue[],
                mode: session.mode,
                approver: 'model',
                decision: authorization.autoDecision.decision,
                reason: authorization.autoDecision.note,
              })
            }

            if (!authorization.ok) {
              result = authorization.result
            } else {
              if (authorization.rememberedRule) {
                const latest = this.#configStore.getPublicConfig()
                await this.#configStore.update({
                  version: 1,
                  kind: 'permission',
                  builtinPolicies: latest.permission.builtinPolicies,
                  rememberedRules: [
                    ...latest.permission.rememberedRules,
                    authorization.rememberedRule,
                  ].slice(-256),
                  sensitiveData: latest.permission.sensitiveData,
                })
              }

              approvedBy = authorization.approvedCall.approvedBy
              diffHash = authorization.approvedCall.diffHash
              const preflight = await this.#preflightToolContext(
                session,
                run,
                call,
              )
              policySignals = [
                ...policySignals,
                ...(toJsonValue(preflight.signals) as JsonValue[]),
              ]

              result = preflight.result
                ? preflight.result
                : await this.#toolExecutor.execute(
                    authorization.approvedCall,
                    {
                      sessionId: session.sessionId,
                      runId: run.runId,
                      workspace: {
                        canonicalPath: session.workspace,
                      },
                    },
                    run.controller.signal,
                  )
            }
          }
        }
      } catch (error) {
        result = toolFailure(error, run.controller.signal)
      }

      const contextResult = boundToolResultForContext(
        result,
        this.#configStore.getPublicConfig().limits,
        run.toolTokensUsed,
      )
      run.toolTokensUsed += contextResult.tokens
      let providerResult = contextResult.result

      try {
        const filtered = await this.#filterToolResultForProvider(
          session,
          run,
          call,
          providerResult,
        )
        providerResult = filtered.result
        policySignals = [
          ...policySignals,
          ...(toJsonValue(filtered.signals) as JsonValue[]),
        ]
      } catch (error) {
        providerResult = toolFailure(error, run.controller.signal)
      }

      await session.logger.write({
        type: 'tool.call',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: call.id,
        tool: call.toolId,
        args: call.args,
        result: toJsonValue(result),
        approvedBy,
        policySignals,
        diffHash,
        durationMs: performance.now() - startedAt,
        totalBytes: 'totalBytes' in result ? result.totalBytes : undefined,
        truncated: 'truncated' in result ? result.truncated : undefined,
      })

      this.#emit(session, {
        type: 'tool.completed',
        sessionId: session.sessionId,
        runId: run.runId,
        callId: call.id,
        result: normalizeToolResult(providerResult),
      })

      await this.#pluginBus
        ?.emit('afterToolCall', {
          version: 1,
          sessionId: session.sessionId,
          runId: run.runId,
          call,
          result,
        })
        .catch((error: unknown) =>
          this.#onDiagnostic('Plugin afterToolCall failed', error),
        )

      session.history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResultForProvider(providerResult),
      })
    }

    if (run.controller.signal.aborted) {
      throw run.controller.signal.reason ?? new Error('Run cancelled')
    }
  }

  async #requestToolApproval(
    session: SessionState,
    run: ActiveRun,
    request: ApprovalRequest,
  ): Promise<HumanApprovalDecision> {
    await this.#pluginBus
      ?.emit('beforeApproval', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        callId: request.call.id,
        policySignals: request.policySignals,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin beforeApproval failed', error),
      )
    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      policySignals: toJsonValue(request.policySignals) as JsonValue[],
      mode: session.mode,
      approver: 'human',
      decision: 'requested',
      reason: request.call.reason,
    })
    this.#setRunStatus(session, run, 'awaiting_approval')
    this.#emit(session, {
      type: 'approval.requested',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      kind: 'tool',
      tool: request.call.toolId,
      args: request.call.args,
      reason: request.call.reason,
      policySignals: request.policySignals,
      diff: request.diff,
      diffHash: request.diffHash,
      rememberable: request.rememberable,
      rememberArgConstraints: request.rememberArgConstraints,
      expiresAt: request.expiresAt,
    })

    const decision = await this.#awaitApproval(
      run,
      request.call.id,
      request.expiresAt,
    )

    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: request.call.id,
      policySignals: toJsonValue(request.policySignals) as JsonValue[],
      mode: session.mode,
      approver: 'human',
      decision: decision.decision,
      reason:
        decision.decision === 'allow'
          ? 'Approved by user'
          : decision.decision === 'deny'
            ? 'Denied by user'
            : 'Approval cancelled',
    })
    this.#setRunStatus(session, run, 'running_tools')
    return decision
  }

  #awaitApproval(
    run: ActiveRun,
    callId: CallId,
    expiresAt: string,
  ): Promise<HumanApprovalDecision> {
    return new Promise<HumanApprovalDecision>((resolve) => {
      const finish = (decision: HumanApprovalDecision) => {
        if (run.pendingApproval?.callId === callId) {
          run.pendingApproval = undefined
        }
        clearTimeout(timer)
        run.controller.signal.removeEventListener('abort', abort)
        resolve(decision)
      }
      const pending: PendingApproval = {
        callId,
        expiresAt: new Date(expiresAt).getTime(),
        resolve: finish,
      }
      run.pendingApproval = pending
      const abort = () => {
        if (run.pendingApproval === pending) {
          finish({ decision: 'cancelled' })
        }
      }
      run.controller.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(
        () => finish({ decision: 'cancelled' }),
        Math.max(0, pending.expiresAt - Date.now()),
      )
    }).finally(() => {
      if (run.pendingApproval?.callId === callId) {
        run.pendingApproval = undefined
      }
    })
  }

  async #requestContextApproval(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
    signals: PolicySignal[],
    summary: string,
  ): Promise<HumanApprovalDecision> {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

    await this.#pluginBus
      ?.emit('beforeApproval', {
        version: 1,
        sessionId: session.sessionId,
        runId: run.runId,
        callId: call.id,
        policySignals: signals,
      })
      .catch((error: unknown) =>
        this.#onDiagnostic('Plugin beforeApproval failed', error),
      )
    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      policySignals: toJsonValue(signals) as JsonValue[],
      mode: this.#configStore.getPublicConfig().permission.sensitiveData.mode,
      approver: 'human',
      decision: 'requested',
      reason: summary,
    })
    this.#setRunStatus(session, run, 'awaiting_approval')
    this.#emit(session, {
      type: 'approval.requested',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      kind: 'context',
      tool: call.toolId,
      args: call.args,
      reason: summary,
      policySignals: signals,
      rememberable: false,
      expiresAt,
    })

    const approval = await this.#awaitApproval(run, call.id, expiresAt)

    await session.logger.write({
      type: 'approval',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      policySignals: toJsonValue(signals) as JsonValue[],
      mode: this.#configStore.getPublicConfig().permission.sensitiveData.mode,
      approver: 'human',
      decision: approval.decision,
      reason:
        approval.decision === 'allow'
          ? 'Approved by user'
          : approval.decision === 'deny'
            ? 'Denied by user'
            : 'Approval cancelled',
    })
    this.#setRunStatus(session, run, 'running_tools')
    return approval
  }

  async #preflightToolContext(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
  ): Promise<{ signals: PolicySignal[]; result?: ToolResult }> {
    if (session.mode === 'yolo') {
      return { signals: [] }
    }

    const decision = this.#ingressFilter.evaluatePath(
      this.#configStore.getPublicConfig().permission.sensitiveData,
      call,
    )

    if (decision.action !== 'confirm') {
      return { signals: decision.signals }
    }

    const approval = await this.#requestContextApproval(
      session,
      run,
      call,
      decision.signals,
      decision.summary,
    )

    return {
      signals: decision.signals,
      ...(approval.decision === 'allow'
        ? {}
        : {
            result:
              approval.decision === 'cancelled'
                ? ({
                    status: 'cancelled',
                    message: 'Context ingress approval was cancelled',
                  } satisfies ToolResult)
                : ({
                    status: 'denied',
                    message:
                      'Tool execution was withheld by sensitive path confirmation',
                  } satisfies ToolResult),
          }),
    }
  }

  async #filterToolResultForProvider(
    session: SessionState,
    run: ActiveRun,
    call: ToolCall,
    result: ToolResult,
  ): Promise<{ result: ToolResult; signals: PolicySignal[] }> {
    if (session.mode === 'yolo') {
      return { result, signals: [] }
    }

    const config = this.#configStore.getPublicConfig()
    const decision = this.#ingressFilter.evaluate(
      config.permission.sensitiveData,
      { call, result },
      { includePaths: false },
    )

    if (decision.action === 'allow' || decision.action === 'warn') {
      return { result, signals: decision.signals }
    }

    const approval = await this.#requestContextApproval(
      session,
      run,
      call,
      decision.signals,
      decision.summary,
    )
    return {
      result:
        approval.decision === 'allow'
          ? result
          : approval.decision === 'cancelled'
            ? {
                status: 'cancelled',
                message: 'Context ingress approval was cancelled',
              }
            : decision.sanitizedResult,
      signals: decision.signals,
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
    if (session.closed && event.type !== 'session.closed') {
      return
    }

    const webContents = this.#getWebContents()

    if (!webContents) {
      return
    }

    sendAgentEvent(webContents, {
      version: IPC_VERSION,
      event: {
        schemaVersion: 1,
        seq: (session.eventSeq += 1),
        ts: new Date().toISOString(),
        ...event,
      } as Parameters<typeof sendAgentEvent>[1]['event'],
    })
  }

  #emitTerminal(event: TerminalEventDraft): void {
    const session = this.#sessions.get(event.sessionId)
    const webContents = this.#getWebContents()

    if (!session || !webContents) {
      return
    }

    const draft: TerminalEventDraftEnvelope =
      event.type === 'terminal.output'
        ? {
            type: 'terminal.output',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            chunk: event.chunk ?? '',
          }
        : {
            type: 'terminal.status',
            sessionId: event.sessionId,
            terminalId: event.terminalId,
            status: event.status ?? 'failed',
            ...(event.exitCode !== undefined
              ? { exitCode: event.exitCode }
              : {}),
          }

    sendTerminalEvent(webContents, {
      version: IPC_VERSION,
      event: {
        schemaVersion: 1,
        seq: event.seq,
        ts: new Date().toISOString(),
        ...draft,
      } as TerminalEvent,
    })
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
