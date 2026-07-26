import type { RunStatus, ToolApprovalSummary } from '../../shared/agent-events'
import type { ProviderPublicConfig } from '../../shared/config'
import type { CallId, MessageId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import { boundToolResultForContext } from '../tools/context-budget'
import { PermissionPipeline } from '../permission/permission-pipeline'
import { hasSideEffects } from '../permission/policy-engine'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types'
import { ProviderAutoApprover } from '../permission/auto-approver'
import type { ToolExecutor } from '../tools/tool-registry'
import { toJsonValue } from './session-common'
import type { PromptRegistry } from '../prompts/registry'
import { normalizeToolResult, toolFailure } from './session-run-utils'
import type { SessionApprovalCoordinator } from '../permission/session-approval'
import type { SessionContextGate } from './session-context-gate'
import { createConfiguredProvider } from './session-provider-turn'
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

type ToolAttemptStage = 'validation' | 'permission' | 'execution'

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
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void
  readonly #setRunStatus: (
    session: SessionState,
    run: ActiveRun,
    status: RunStatus,
    error?: unknown,
  ) => void

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
    onDiagnostic: (message: string, error?: unknown) => void
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
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
  }

  /** Runs the requested tool calls, emits results, and records durable file changes. */
  async executeToolCalls(
    session: SessionState,
    run: ActiveRun,
    toolCalls: ToolCall[],
    assistantMessageId: MessageId,
  ): Promise<void> {
    this.#setRunStatus(session, run, 'running_tools')
    const terminalCallIds = new Set<CallId>()

    try {
      for (const providerCall of toolCalls) {
        let call = providerCall
        let definitionOverride: ToolDefinition | undefined
        let resolutionFailure: ToolResult | undefined
        let attemptStage: ToolAttemptStage = 'validation'
        let attemptEffects: string[] = []
        const resolution = this.#mcpGateway?.resolveCall(session, providerCall)
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

        let result: ToolResult
        let approvedBy = 'none'
        let policySignals: JsonValue[] = []
        let diffHash: string | undefined
        let preparedFileChange: PreparedFileChange | undefined
        let approvedDiff = ''
        let approvalUsageProvider: ProviderPublicConfig | undefined
        let approvalSummary: ToolApprovalSummary | undefined
        const startedAt = performance.now()
        try {
          if (run.controller.signal.aborted) {
            result = { status: 'cancelled', message: 'The run was cancelled' }
          } else if (resolutionFailure) {
            result = resolutionFailure
          } else {
            const inspected = this.#toolExecutor.inspectCall(
              call,
              definitionOverride,
            )

            if (!inspected.ok) {
              attemptEffects = [...(inspected.definition?.effects ?? [])]
              result = inspected.result
            } else {
              attemptStage = 'permission'
              attemptEffects = [...inspected.definition.effects]
              const config = this.#configStore.getPublicConfig()
              const approvalBinding = run.routes?.approval
              const configuredApproverProvider = approvalBinding?.provider
              approvalUsageProvider = configuredApproverProvider
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
                  this.#approvals.requestToolApproval(session, run, request),
              })
              policySignals = toJsonValue(
                authorization.policySignals,
              ) as JsonValue[]

              if (authorization.autoDecision) {
                approvalSummary = {
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
                        raw: authorization.autoDecision.usage,
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
                result = authorization.result
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

                approvedBy = authorization.approvedCall.approvedBy
                diffHash = authorization.approvedCall.diffHash
                approvedDiff = authorization.diff ?? ''
                const preflight = await this.#contextGate.preflightToolContext(
                  session,
                  run,
                  call,
                )
                policySignals = [
                  ...policySignals,
                  ...(toJsonValue(preflight.signals) as JsonValue[]),
                ]

                if (preflight.result) {
                  result = preflight.result
                } else {
                  attemptStage = 'execution'
                  try {
                    try {
                      preparedFileChange =
                        await this.#fileChangeExecution?.prepareMutation({
                          sessionId: session.sessionId,
                          assistantMessageId,
                          workspace: session.workspace,
                          approvedCall: authorization.approvedCall,
                          diff: approvedDiff,
                          maximumPayloadBytes: run.fileChangeHistoryBytes,
                        })
                    } catch (error) {
                      throw new FileChangePreparationFailure(error)
                    }
                    result = await this.#toolExecutor.execute(
                      authorization.approvedCall,
                      {
                        sessionId: session.sessionId,
                        runId: run.runId,
                        workspace: {
                          canonicalPath: session.workspace,
                        },
                      },
                      run.controller.signal,
                      hasSideEffects(inspected.definition)
                        ? (settlement) => {
                            run.pendingSideEffects.add(settlement)
                            void settlement
                              .finally(() =>
                                run.pendingSideEffects.delete(settlement),
                              )
                              .catch(() => undefined)
                          }
                        : undefined,
                      definitionOverride,
                    )
                  } catch (error) {
                    if (error instanceof FileChangePreparationFailure) {
                      throw error
                    }
                    result = toolFailure(error, run.controller.signal)
                  }
                }
              }
            }
          }
        } catch (error) {
          if (error instanceof FileChangePreparationFailure) {
            throw error.cause
          }
          result = toolFailure(error, run.controller.signal)
        }

        if (
          result.status === 'ok' &&
          preparedFileChange &&
          this.#fileChangeExecution
        ) {
          const mutation = await this.#fileChangeExecution
            .commitMutation({
              workspace: session.workspace,
              prepared: preparedFileChange,
            })
            .catch((error: unknown) => {
              this.#onDiagnostic(
                'Failed to finalize durable file change',
                error,
              )
              return {
                status: 'warning' as const,
                warningCode: 'CHANGE_HISTORY_PERSIST_FAILED' as const,
              }
            })
          result = annotateFileMutationResult(result, mutation)
        }

        const contextResult = boundToolResultForContext(
          result,
          this.#configStore.getPublicConfig().limits,
          run.toolTokensUsed,
        )
        run.toolTokensUsed += contextResult.tokens
        let providerResult = contextResult.result

        try {
          const filtered = await this.#contextGate.filterToolResultForProvider(
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

        const durationMs = performance.now() - startedAt
        const attempt = {
          type: 'tool.attempt' as const,
          sessionId: session.sessionId,
          runId: run.runId,
          callId: call.id,
          tool: call.toolId,
          stage: attemptStage,
          outcome: attemptOutcome(attemptStage, result),
          effects: attemptEffects,
          durationMs,
          inputBytes: serializedBytes(call.args),
          outputBytes:
            'totalBytes' in result && result.totalBytes !== undefined
              ? result.totalBytes
              : serializedBytes(result),
          truncated: 'truncated' in result && result.truncated === true,
          ...(result.status === 'error' ? { errorCode: result.code } : {}),
        }
        await session.logger.write(attempt)
        this.#emit(session, attempt)

        await session.logger.write({
          type: 'tool.call',
          sessionId: session.sessionId,
          runId: run.runId,
          callId: call.id,
          tool: call.toolId,
          args: call.args,
          reason: call.reason,
          result: toJsonValue(result),
          approvedBy,
          policySignals,
          diffHash,
          durationMs,
          totalBytes: 'totalBytes' in result ? result.totalBytes : undefined,
          truncated: 'truncated' in result ? result.truncated : undefined,
        })

        this.#emit(session, {
          type: 'tool.completed',
          sessionId: session.sessionId,
          runId: run.runId,
          callId: call.id,
          result: normalizeToolResult(providerResult),
          ...(approvalSummary ? { approval: approvalSummary } : {}),
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

        appendToolResult(session, {
          callId: call.id,
          content: toJsonValue(providerResult),
          isError: providerResult.status !== 'ok',
          name: call.toolId,
          reason: call.reason,
          status:
            providerResult.status === 'ok'
              ? 'completed'
              : providerResult.status === 'denied'
                ? 'denied'
                : providerResult.status === 'cancelled'
                  ? 'cancelled'
                  : providerResult.status === 'timeout'
                    ? 'timed_out'
                    : 'failed',
          truncated:
            'truncated' in providerResult && providerResult.truncated === true,
          durationMs,
          turnId: run.rootUserMessageId,
        })
        terminalCallIds.add(providerCall.id)
      }
    } catch (error) {
      const cancelled = run.controller.signal.aborted
      for (const call of toolCalls) {
        if (terminalCallIds.has(call.id)) continue
        appendToolResult(session, {
          callId: call.id,
          content: {
            status: cancelled ? 'cancelled' : 'error',
            message: cancelled
              ? 'The run was cancelled before the tool batch completed'
              : 'The tool batch failed before this result could be finalized',
          },
          isError: true,
          name: call.toolId,
          reason: call.reason,
          status: cancelled ? 'cancelled' : 'failed',
          truncated: false,
          turnId: run.rootUserMessageId,
        })
        terminalCallIds.add(call.id)
      }
      throw error
    }

    if (run.controller.signal.aborted) {
      throw run.controller.signal.reason ?? new Error('Run cancelled')
    }
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
