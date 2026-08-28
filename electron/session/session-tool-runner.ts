import type { RunStatus, ToolApprovalSummary } from '../../shared/agent-events'
import type { CallId, MessageId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import { boundToolResultProjectionForContext } from '../tools/context-budget'
import { isGitReadOnlyToolId } from '../tools/git-tool-ids'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { hasSideEffects } from '../permission/policy-engine'
import type { PluginEventBus } from '../plugins/event-bus'
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionMode,
  ToolResult,
  ToolResultProjection,
} from '../tools/types'
import type { ApprovedToolCall } from '../tools/approved-tool-call'
import { ProviderAutoApprover } from '../permission/auto-approver'
import type { ToolExecutor } from '../tools/tool-registry'
import { toJsonValue } from './session-common'
import type { PromptRegistry } from '../prompts/registry'
import {
  modelOutputTokenLimit,
  normalizeToolResult,
  toolFailure,
} from './session-run-utils'
import type { SessionApprovalCoordinator } from '../permission/session-approval'
import type { SessionContextGate } from './session-context-gate'
import { createConfiguredProvider } from '../providers/provider-factory'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import { normalizeLlmUsage } from '../providers/usage'
import type { McpToolGateway } from '../tools/mcp-tools'
import { appendToolResult } from './canonical-history'
import type {
  FileChangeExecutionPort,
  PreparedFileChange,
} from './file-change-execution'
import {
  toolResultProjectionText,
  toolResultProjectionValue,
} from '../tools/tool-result-projection'
import type { OperationalLogService } from '../operational-logging/service'
import {
  associateDiagnosticCode,
  associateDiagnosticId,
} from '../operational-logging/diagnostic-id'

type ToolAttemptStage = 'validation' | 'permission' | 'execution'

interface ToolCallSegment {
  mode: ToolExecutionMode
  calls: ToolCall[]
}

interface ToolCallExecution {
  providerCall: ToolCall
  call: ToolCall
  definitionOverride?: ToolDefinition
  definition?: ToolDefinition
  approvedCall?: ApprovedToolCall
  attemptStage: ToolAttemptStage
  attemptEffects: string[]
  result?: ToolResult
  approvedBy: string
  policySignals: JsonValue[]
  diffHash?: string
  preparedFileChange?: PreparedFileChange
  approvalSummary?: ToolApprovalSummary
  durationMs: number
}

/** Wraps a durable file-change preparation failure while preserving its original cause. */
class FileChangePreparationFailure extends Error {
  constructor(readonly cause: unknown) {
    super('Durable file change preparation failed')
    this.name = 'FileChangePreparationFailure'
  }
}

function attemptOutcome(
  stage: ToolAttemptStage,
  result: ToolResult,
): 'rejected' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'timeout' {
  if (result.status === 'denied') return 'denied'
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'timeout') return 'timeout'
  if (stage !== 'execution') return 'rejected'
  return result.status === 'ok' ? 'succeeded' : 'failed'
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(toJsonValue(value)), 'utf8')
}

function toolResultStatus(
  result: ToolResult,
): 'completed' | 'denied' | 'failed' | 'cancelled' | 'timed_out' {
  if (result.status === 'ok') return 'completed'
  if (result.status === 'denied') return 'denied'
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'timeout') return 'timed_out'
  return 'failed'
}

function projectedEventResult(
  source: ToolResult,
  projection: ToolResultProjection,
  totalBytes: number,
): ToolResult {
  if (source.status === 'ok') {
    return {
      status: 'ok',
      content: toolResultProjectionValue(projection),
      truncated: projection.truncated,
      totalBytes,
    }
  }
  const message = toolResultProjectionText(projection)
  if (source.status === 'error') {
    return { ...source, message }
  }
  return { status: source.status, message }
}

function operationalToolCorrelation(session: SessionState, run: ActiveRun) {
  return {
    sessionId: session.sessionId,
    runId: run.runId,
    ...(run.lastToolBatchId ? { toolBatchId: run.lastToolBatchId } : {}),
    ...(session.logger.traceId ? { traceId: session.logger.traceId } : {}),
    ...(session.internalExecution
      ? { agentExecutionId: session.internalExecution.executionId }
      : {}),
  }
}

/** Executes tool calls, approvals, file changes, and provider-facing result annotations. */
export class SessionToolRunner {
  readonly #configStore: ConfigStore
  readonly #pluginBus: PluginEventBus | undefined
  readonly #fileChangeExecution: FileChangeExecutionPort | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #permissionPipeline: PermissionPipeline
  readonly #toolExecutor: ToolExecutor
  readonly #approvals: SessionApprovalCoordinator
  readonly #contextGate: SessionContextGate
  readonly #mcpGateway: McpToolGateway | undefined
  readonly #onDiagnostic: DiagnosticSink
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #setRunStatus: (
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ) => void
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined

  constructor(options: {
    configStore: ConfigStore
    pluginBus?: PluginEventBus
    fileChangeExecution?: FileChangeExecutionPort
    promptRegistry?: PromptRegistry
    fetchImpl?: typeof fetch
    autoApproverFactory: SessionManagerOptions['autoApproverFactory']
    permissionPipeline: PermissionPipeline
    toolExecutor: ToolExecutor
    approvals: SessionApprovalCoordinator
    contextGate: SessionContextGate
    mcpGateway?: McpToolGateway
    onDiagnostic: DiagnosticSink
    operationalLog?: Pick<OperationalLogService, 'log'>
    emit: (session: SessionState, event: AgentEventDraft) => void
    setRunStatus: (
      session: SessionState,
      run: ActiveRun,
      status: RunStatus,
      error?: unknown,
    ) => void
  }) {
    this.#configStore = options.configStore
    this.#pluginBus = options.pluginBus
    this.#fileChangeExecution = options.fileChangeExecution
    this.#promptRegistry = options.promptRegistry
    this.#fetchImpl = options.fetchImpl
    this.#autoApproverFactory = options.autoApproverFactory
    this.#permissionPipeline = options.permissionPipeline
    this.#toolExecutor = options.toolExecutor
    this.#approvals = options.approvals
    this.#contextGate = options.contextGate
    this.#mcpGateway = options.mcpGateway
    this.#onDiagnostic = options.onDiagnostic
    this.#operationalLog = options.operationalLog
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
  }

  /** Runs tool calls with serial preparation/finalization and parallel-safe bodies. */
  async executeToolCalls(
    session: SessionState,
    run: ActiveRun,
    toolCalls: ToolCall[],
    assistantMessageId: MessageId,
  ): Promise<void> {
    this.#setRunStatus(session, run, 'running_tools')
    const terminalCallIds = new Set<CallId>()
    this.#operationalLog?.log({
      level: 'debug',
      event: 'tool.batch.started',
      ...operationalToolCorrelation(session, run),
      itemCount: toolCalls.length,
    })

    try {
      for (const segment of this.#toolCallSegments(toolCalls)) {
        const prepared: ToolCallExecution[] = []
        for (const providerCall of segment.calls) {
          prepared.push(
            await this.#prepareToolCall(
              session,
              run,
              providerCall,
              assistantMessageId,
            ),
          )
        }

        if (segment.mode === 'parallel') {
          const settlements = await Promise.allSettled(
            prepared.map((execution) =>
              this.#executePreparedTool(session, run, execution),
            ),
          )
          for (const [index, settlement] of settlements.entries()) {
            const execution = prepared[index]
            if (
              execution &&
              settlement.status === 'rejected' &&
              !execution.result
            ) {
              execution.result = toolFailure(
                settlement.reason,
                run.controller.signal,
              )
            }
          }
        } else {
          const execution = prepared[0]
          if (execution) {
            await this.#executePreparedTool(session, run, execution)
          }
        }

        for (const execution of prepared) {
          await this.#finalizeToolCall(session, run, execution, terminalCallIds)
        }
      }
    } catch (error) {
      const cancelled = run.controller.signal.aborted
      if (cancelled) {
        this.#operationalLog?.log({
          level: 'debug',
          event: 'tool.batch.completed',
          ...operationalToolCorrelation(session, run),
          outcome: 'cancelled',
          itemCount: toolCalls.length,
        })
      } else {
        const diagnostic = this.#operationalLog?.log({
          level: 'error',
          event: 'tool.batch.failed',
          ...operationalToolCorrelation(session, run),
          code: 'TOOL_BATCH_FAILED',
          error,
          itemCount: toolCalls.length,
        })
        associateDiagnosticCode(error, 'TOOL_BATCH_FAILED')
        associateDiagnosticId(error, diagnostic?.diagnosticId)
      }
      for (const call of toolCalls) {
        if (terminalCallIds.has(call.id)) continue
        const result: ToolResult = cancelled
          ? {
              status: 'cancelled',
              message: 'The run was cancelled before the tool batch completed',
            }
          : {
              status: 'error',
              code: 'TOOL_BATCH_FAILED',
              message:
                'The tool batch failed before this result could be finalized',
              retryable: false,
            }
        const projected = this.#projectForContext(run, call, result)
        appendToolResult(session, {
          callId: call.id,
          content: projected.projection.content,
          isError: true,
          name: call.toolId,
          reason: call.reason,
          status: cancelled ? 'cancelled' : 'failed',
          truncated: projected.projection.truncated,
          turnId: run.rootUserMessageId,
        })
        terminalCallIds.add(call.id)
      }
      throw error
    }

    this.#operationalLog?.log({
      level: 'debug',
      event: 'tool.batch.completed',
      ...operationalToolCorrelation(session, run),
      outcome: run.controller.signal.aborted ? 'cancelled' : 'completed',
      itemCount: toolCalls.length,
    })

    if (run.controller.signal.aborted) {
      throw run.controller.signal.reason ?? new Error('Run cancelled')
    }
  }

  /** Splits model calls into maximal parallel groups separated by serial barriers. */
  #toolCallSegments(toolCalls: readonly ToolCall[]): ToolCallSegment[] {
    const segments: ToolCallSegment[] = []
    for (const providerCall of toolCalls) {
      const call = this.#toolExecutor.normalizeCall(providerCall)
      const inspected = this.#toolExecutor.inspectCall(call)
      const mode = inspected.definition?.executionMode ?? 'serial'
      const previous = segments.at(-1)
      if (mode === 'parallel' && previous?.mode === 'parallel') {
        previous.calls.push(providerCall)
      } else {
        segments.push({ mode, calls: [providerCall] })
      }
    }
    return segments
  }

  /** Resolves, authorizes, and preflights one call without starting its body. */
  async #prepareToolCall(
    session: SessionState,
    run: ActiveRun,
    providerCall: ToolCall,
    assistantMessageId: MessageId,
  ): Promise<ToolCallExecution> {
    let call = this.#toolExecutor.normalizeCall(providerCall)
    let definitionOverride: ToolDefinition | undefined
    let resolutionFailure: ToolResult | undefined
    if (!this.#isToolAllowed(session, run, call.toolId)) {
      resolutionFailure = {
        status: 'error',
        code: 'TOOL_NOT_AVAILABLE',
        message: 'Tool is not available in this Run: ' + call.toolId,
        retryable: false,
      }
    }
    const resolution = resolutionFailure
      ? undefined
      : this.#mcpGateway?.resolveCall(session, call)
    if (resolution?.matched) {
      if (resolution.ok) {
        call = resolution.call
        definitionOverride = resolution.definition
      } else {
        resolutionFailure = resolution.result
      }
    }

    const proposed = {
      type: 'tool.proposed',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: call.id,
      tool: call.toolId,
      args: call.args,
      reason: call.reason,
    } as const
    await session.logger.write(proposed)
    this.#emit(session, proposed)
    this.#operationalLog?.log({
      level: 'debug',
      event: 'tool.proposed',
      ...operationalToolCorrelation(session, run),
      callId: call.id,
      toolName: call.toolId,
      inputBytes: serializedBytes(call.args),
    })

    const execution: ToolCallExecution = {
      providerCall,
      call,
      definitionOverride,
      attemptStage: 'validation',
      attemptEffects: [],
      approvedBy: 'none',
      policySignals: [],
      durationMs: 0,
    }
    const startedAt = performance.now()
    try {
      if (run.controller.signal.aborted) {
        execution.result = {
          status: 'cancelled',
          message: 'The run was cancelled',
        }
      } else if (resolutionFailure) {
        execution.result = resolutionFailure
      } else {
        const inspected = this.#toolExecutor.inspectCall(
          call,
          definitionOverride,
        )
        if (!inspected.ok) {
          execution.attemptEffects = [...(inspected.definition?.effects ?? [])]
          execution.result = inspected.result
        } else {
          execution.attemptStage = 'permission'
          execution.attemptEffects = [...inspected.definition.effects]
          const config = this.#configStore.getPublicConfig()
          const approvalBinding = run.routes?.approval
          const configuredApproverProvider = approvalBinding?.provider
          const approvalUsageProvider = configuredApproverProvider
            ? {
                ...configuredApproverProvider,
                model: approvalBinding.snapshot.model,
                reasoning: approvalBinding.snapshot.reasoning,
              }
            : undefined
          const apiKey = approvalBinding?.apiKey
          const autoApprover =
            session.mode === 'auto' && apiKey && approvalUsageProvider
              ? (this.#autoApproverFactory?.({ config, apiKey }) ??
                new ProviderAutoApprover(
                  createConfiguredProvider(
                    approvalUsageProvider,
                    apiKey,
                    this.#fetchImpl,
                    approvalBinding.snapshot.endpoint,
                  ),
                  approvalBinding.snapshot,
                  config.limits.autoApprovalTimeoutMs,
                  this.#promptRegistry?.approvalPrompt().content,
                  modelOutputTokenLimit(approvalBinding.modelProfile),
                  {
                    operationalLog: this.#operationalLog,
                    sessionId: session.sessionId,
                    runId: run.runId,
                    callId: call.id,
                    ...(session.internalExecution
                      ? {
                          agentExecutionId:
                            session.internalExecution.executionId,
                        }
                      : {}),
                    ...(session.logger.traceId
                      ? { traceId: session.logger.traceId }
                      : {}),
                  },
                ))
              : undefined
          const authorization = await this.#permissionPipeline.authorize({
            sessionId: session.sessionId,
            runId: run.runId,
            workspace: session.workspace,
            sessionTemp: session.sessionTemp,
            mode: session.mode,
            call,
            definition: inspected.definition,
            config,
            signal: run.controller.signal,
            autoApprover,
            beforeToolCall: (currentRisk) =>
              session.visibility === 'public'
                ? (this.#pluginBus?.emit('beforeToolCall', {
                    version: 1,
                    sessionId: session.sessionId,
                    runId: run.runId,
                    call,
                    currentRisk,
                  }) ?? Promise.resolve(undefined))
                : Promise.resolve(undefined),
            requestHumanApproval: (request) =>
              this.#approvals.requestToolApproval(session, run, request),
          })
          execution.policySignals = toJsonValue(
            authorization.policySignals,
          ) as JsonValue[]

          if (authorization.autoDecision) {
            execution.approvalSummary = {
              approver: 'model',
              decision: authorization.autoDecision.decision,
              reason: authorization.autoDecision.note,
              valid: authorization.autoDecision.valid,
              ...(authorization.autoDecision.failure
                ? { failure: authorization.autoDecision.failure }
                : {}),
            }
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
            const approvalUsage =
              approvalUsageProvider && authorization.autoDecision.usage
                ? normalizeLlmUsage({
                    scope: 'approval',
                    config,
                    provider: approvalUsageProvider,
                    model: approvalBinding!.snapshot.model,
                    modelProfile: approvalBinding?.modelProfile,
                    usage: authorization.autoDecision.usage,
                  })
                : undefined
            if (approvalUsage) {
              await session.logger.write({
                type: 'llm.usage',
                sessionId: session.sessionId,
                runId: run.runId,
                callId: call.id,
                usage: approvalUsage,
              })
              this.#emit(session, {
                type: 'llm.usage',
                sessionId: session.sessionId,
                runId: run.runId,
                callId: call.id,
                usage: approvalUsage,
              })
            }
          }

          if (!authorization.ok) {
            execution.result = authorization.result
          } else {
            if (authorization.rememberedRule) {
              const latest = this.#configStore.getPublicConfig()
              await this.#configStore.update({
                version: 1,
                kind: 'permission',
                defaultMode: latest.permission.defaultMode,
                builtinPolicies: latest.permission.builtinPolicies,
                rememberedRules: [
                  ...latest.permission.rememberedRules,
                  authorization.rememberedRule,
                ].slice(-256),
                sensitiveData: latest.permission.sensitiveData,
              })
            }

            execution.approvedBy = authorization.approvedCall.approvedBy
            execution.diffHash = authorization.approvedCall.diffHash
            execution.approvedCall = authorization.approvedCall
            execution.definition = inspected.definition
            const preflight = await this.#contextGate.preflightToolContext(
              session,
              run,
              call,
            )
            execution.policySignals = [
              ...execution.policySignals,
              ...(toJsonValue(preflight.signals) as JsonValue[]),
            ]
            if (preflight.result) {
              execution.result = preflight.result
            } else {
              execution.attemptStage = 'execution'
              try {
                execution.preparedFileChange =
                  session.visibility === 'public' &&
                  !authorization.approvedCall.resourcePreconditions.some(
                    (precondition) => precondition.rootKind === 'session-temp',
                  )
                    ? await this.#fileChangeExecution?.prepareMutation({
                        sessionId: session.sessionId,
                        assistantMessageId,
                        workspace: session.workspace,
                        approvedCall: authorization.approvedCall,
                        diff: authorization.diff ?? '',
                        maximumPayloadBytes: run.fileChangeHistoryBytes,
                      })
                    : undefined
              } catch (error) {
                throw new FileChangePreparationFailure(error)
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof FileChangePreparationFailure) {
        throw error.cause
      }
      execution.result = toolFailure(error, run.controller.signal)
    } finally {
      execution.durationMs += performance.now() - startedAt
    }
    return execution
  }

  /** Executes one prepared body; callers decide whether sibling bodies overlap. */
  async #executePreparedTool(
    session: SessionState,
    run: ActiveRun,
    execution: ToolCallExecution,
  ): Promise<void> {
    if (execution.result) return
    const startedAt = performance.now()
    this.#operationalLog?.log({
      level: 'debug',
      event: 'tool.execution.started',
      ...operationalToolCorrelation(session, run),
      callId: execution.call.id,
      toolName: execution.call.toolId,
      executionMode: execution.definition?.executionMode,
      effects: execution.attemptEffects,
      phase: execution.attemptStage,
    })
    try {
      if (run.controller.signal.aborted) {
        execution.result = {
          status: 'cancelled',
          message: 'The run was cancelled',
        }
      } else if (!execution.approvedCall || !execution.definition) {
        execution.result = {
          status: 'error',
          code: 'TOOL_EXECUTION_NOT_PREPARED',
          message: 'The tool call could not be prepared for execution',
          retryable: false,
        }
      } else {
        execution.result = await this.#toolExecutor.execute(
          execution.approvedCall,
          {
            sessionId: session.sessionId,
            ownerSessionId: session.ownerSessionId,
            runId: run.runId,
            workspace: {
              canonicalPath: session.workspace,
            },
            sessionTemp: session.sessionTemp,
            maxSubagents: run.maxSubagents,
            toolOutputLimits: run.toolOutputLimits,
            readOnlyWorkspace: session.readOnlyWorkspace,
          },
          run.controller.signal,
          hasSideEffects(execution.definition) ||
            session.visibility === 'internal'
            ? (settlement) => {
                run.pendingSideEffects.add(settlement)
                void settlement
                  .finally(() => run.pendingSideEffects.delete(settlement))
                  .catch(() => undefined)
              }
            : undefined,
          execution.definitionOverride,
        )
      }
    } catch (error) {
      execution.result = toolFailure(error, run.controller.signal)
    } finally {
      execution.durationMs += performance.now() - startedAt
    }
  }

  /** Finalizes one result in provider order and appends its canonical history. */
  async #finalizeToolCall(
    session: SessionState,
    run: ActiveRun,
    execution: ToolCallExecution,
    terminalCallIds: Set<CallId>,
  ): Promise<void> {
    const startedAt = performance.now()
    let result: ToolResult = execution.result ?? {
      status: 'error',
      code: 'TOOL_EXECUTION_MISSING_RESULT',
      message: 'The tool call completed without a result',
      retryable: false,
    }

    if (
      result.status === 'ok' &&
      execution.preparedFileChange &&
      this.#fileChangeExecution
    ) {
      const mutation = await this.#fileChangeExecution
        .commitMutation({
          workspace: session.workspace,
          prepared: execution.preparedFileChange,
        })
        .catch((error: unknown) => {
          this.#onDiagnostic('Failed to finalize durable file change', error, {
            audience: 'internal',
          })
          return {
            status: 'warning' as const,
            warningCode: 'CHANGE_HISTORY_PERSIST_FAILED' as const,
          }
        })
      result = annotateFileMutationResult(result, mutation)
    }

    let providerResult = result
    try {
      const filtered = await this.#contextGate.filterToolResultForProvider(
        session,
        run,
        execution.call,
        providerResult,
      )
      providerResult = filtered.result
      execution.policySignals = [
        ...execution.policySignals,
        ...(toJsonValue(filtered.signals) as JsonValue[]),
      ]
    } catch (error) {
      providerResult = toolFailure(error, run.controller.signal)
    }
    const projected = this.#projectForContext(
      run,
      execution.call,
      providerResult,
      execution.definitionOverride,
    )
    execution.durationMs += performance.now() - startedAt
    const durationMs = execution.durationMs
    const attempt = {
      type: 'tool.attempt' as const,
      sessionId: session.sessionId,
      runId: run.runId,
      callId: execution.call.id,
      tool: execution.call.toolId,
      stage: execution.attemptStage,
      outcome: attemptOutcome(execution.attemptStage, result),
      effects: execution.attemptEffects,
      durationMs,
      inputBytes: serializedBytes(execution.call.args),
      outputBytes:
        'totalBytes' in result && result.totalBytes !== undefined
          ? result.totalBytes
          : serializedBytes(result),
      truncated: 'truncated' in result && result.truncated === true,
      ...(result.status === 'error' ? { errorCode: result.code } : {}),
    }
    await session.logger.write(attempt)
    this.#emit(session, attempt)
    const outputBytes =
      'totalBytes' in result && result.totalBytes !== undefined
        ? result.totalBytes
        : serializedBytes(result)
    const operationalFailure =
      result.status !== 'ok' && result.status !== 'cancelled'
    this.#operationalLog?.log({
      level: operationalFailure ? 'warn' : 'debug',
      event: operationalFailure
        ? 'tool.execution.failed'
        : 'tool.execution.completed',
      ...operationalToolCorrelation(session, run),
      callId: execution.call.id,
      toolName: execution.call.toolId,
      executionMode: execution.definition?.executionMode,
      effects: execution.attemptEffects,
      phase: execution.attemptStage,
      approval: execution.approvedBy,
      durationMs,
      inputBytes: serializedBytes(execution.call.args),
      outputBytes,
      truncated: 'truncated' in result && result.truncated === true,
      outcome: attempt.outcome,
      ...(result.status === 'error' ? { code: result.code } : {}),
    })

    await session.logger.write({
      type: 'tool.call',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: execution.call.id,
      tool: execution.call.toolId,
      args: execution.call.args,
      reason: execution.call.reason,
      result: toJsonValue(result),
      approvedBy: execution.approvedBy,
      policySignals: execution.policySignals,
      diffHash: execution.diffHash,
      durationMs,
      totalBytes: 'totalBytes' in result ? result.totalBytes : undefined,
      truncated: 'truncated' in result ? result.truncated : undefined,
    })

    this.#emit(session, {
      type: 'tool.completed',
      sessionId: session.sessionId,
      runId: run.runId,
      callId: execution.call.id,
      result: normalizeToolResult(projected.eventResult),
      ...(execution.approvalSummary
        ? { approval: execution.approvalSummary }
        : {}),
    })

    if (session.visibility === 'public') {
      await this.#pluginBus
        ?.emit('afterToolCall', {
          version: 1,
          sessionId: session.sessionId,
          runId: run.runId,
          call: execution.call,
          result,
        })
        .catch((error: unknown) =>
          this.#onDiagnostic('Plugin afterToolCall failed', error),
        )
    }

    appendToolResult(session, {
      callId: execution.call.id,
      content: projected.projection.content,
      isError: projected.projection.isError,
      name: execution.call.toolId,
      reason: execution.call.reason,
      status: toolResultStatus(providerResult),
      truncated: projected.projection.truncated,
      durationMs,
      turnId: run.rootUserMessageId,
    })
    terminalCallIds.add(execution.providerCall.id)
  }

  #projectForContext(
    run: ActiveRun,
    call: ToolCall,
    result: ToolResult,
    definitionOverride?: ToolDefinition,
  ): {
    projection: ToolResultProjection
    eventResult: ToolResult
  } {
    const projection = this.#toolExecutor.projectResultForModel(
      call,
      result,
      definitionOverride,
      (message, error) => this.#onDiagnostic(message, error),
    )
    const totalBytes = Buffer.byteLength(
      toolResultProjectionText(projection),
      'utf8',
    )
    const bounded = boundToolResultProjectionForContext(
      projection,
      run.toolOutputLimits,
    )
    return {
      projection: bounded,
      eventResult: projectedEventResult(result, bounded, totalBytes),
    }
  }

  #isToolAllowed(
    session: SessionState,
    run: ActiveRun,
    toolId: string,
  ): boolean {
    if (run.allowedToolIds && !run.allowedToolIds.has(toolId)) return false
    if (toolId === 'subagent_run' && !run.subagentsEnabled) return false
    if (toolId === 'swarm_run' && !run.swarmToolConfig) return false
    if (!session.gitToolsEnabled && isGitReadOnlyToolId(toolId)) {
      return false
    }
    return true
  }
}

function annotateFileMutationResult(
  result: Extract<ToolResult, { status: 'ok' }>,
  mutation: Awaited<ReturnType<FileChangeExecutionPort['commitMutation']>>,
): ToolResult {
  const content =
    result.content &&
    typeof result.content === 'object' &&
    !Array.isArray(result.content)
      ? result.content
      : { result: result.content }
  return {
    ...result,
    content:
      mutation.status === 'recorded'
        ? {
            ...content,
            mutationSucceeded: true,
            revertAvailable: true,
            fileChangeId: mutation.fileChange.id,
          }
        : {
            ...content,
            mutationSucceeded: true,
            warningCode: mutation.warningCode,
            revertAvailable: false,
          },
  }
}
