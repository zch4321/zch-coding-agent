import type { RunStatus } from '../../shared/agent-events'
import {
  getProviderConfig,
  type ProviderPublicConfig,
} from '../../shared/config'
import type { JsonValue } from '../../shared/json'
import type { ConfigStore } from '../config/store'
import type { ChangeHistoryStore } from './change-history'
import { boundToolResultForContext } from '../tools/context-budget'
import { PermissionPipeline } from './permission-pipeline'
import type { ApprovedToolCall } from '../tools/approved-tool-call'
import type { PluginEventBus } from '../plugins/event-bus'
import type { ToolCall, ToolResult } from '../tools/types'
import { ProviderAutoApprover } from './auto-approver'
import type { ToolExecutor } from '../tools/tool-registry'
import { toJsonValue } from './session-common'
import type { PromptRegistry } from '../prompts/registry'
import {
  normalizeToolResult,
  toolFailure,
  toolResultForProvider,
} from './session-run-utils'
import type { SessionApprovalCoordinator } from './session-approval'
import type { SessionContextGate } from './session-context-gate'
import { createConfiguredProvider } from './session-provider-turn'
import type {
  ActiveRun,
  AgentEventDraft,
  SessionManagerOptions,
  SessionState,
} from './session-types'
import { normalizeLlmUsage } from '../providers/usage'

export class SessionToolRunner {
  readonly #configStore: ConfigStore
  readonly #pluginBus: PluginEventBus | undefined
  readonly #changeHistory: ChangeHistoryStore | undefined
  readonly #promptRegistry: PromptRegistry | undefined
  readonly #fetchImpl: SessionManagerOptions['fetchImpl']
  readonly #autoApproverFactory: SessionManagerOptions['autoApproverFactory']
  readonly #permissionPipeline: PermissionPipeline
  readonly #toolExecutor: ToolExecutor
  readonly #approvals: SessionApprovalCoordinator
  readonly #contextGate: SessionContextGate
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
    changeHistory?: ChangeHistoryStore
    promptRegistry?: PromptRegistry
    fetchImpl?: typeof fetch
    autoApproverFactory: SessionManagerOptions['autoApproverFactory']
    permissionPipeline: PermissionPipeline
    toolExecutor: ToolExecutor
    approvals: SessionApprovalCoordinator
    contextGate: SessionContextGate
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
    this.#changeHistory = options.changeHistory
    this.#promptRegistry = options.promptRegistry
    this.#fetchImpl = options.fetchImpl
    this.#autoApproverFactory = options.autoApproverFactory
    this.#permissionPipeline = options.permissionPipeline
    this.#toolExecutor = options.toolExecutor
    this.#approvals = options.approvals
    this.#contextGate = options.contextGate
    this.#onDiagnostic = options.onDiagnostic
    this.#emit = options.emit
    this.#setRunStatus = options.setRunStatus
  }

  async executeToolCalls(
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
      let approvedCall: ApprovedToolCall | undefined
      let approvedDiff = ''
      let approvalUsageProvider: ProviderPublicConfig | undefined
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
            const configuredApproverProvider = getProviderConfig(
              config,
              config.approval.approverProviderId,
            )
            approvalUsageProvider = configuredApproverProvider
              ? {
                  ...configuredApproverProvider,
                  model: config.approval.approverModel,
                  reasoning: 'off',
                }
              : undefined
            const apiKey = configuredApproverProvider
              ? await this.#configStore.getProviderApiKey(
                  configuredApproverProvider.id,
                )
              : undefined
            const autoApprover =
              session.mode === 'auto' && apiKey && approvalUsageProvider
                ? (this.#autoApproverFactory?.({ config, apiKey }) ??
                  new ProviderAutoApprover(
                    createConfiguredProvider(
                      config,
                      approvalUsageProvider,
                      apiKey,
                      this.#fetchImpl,
                    ),
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
              approvedCall = authorization.approvedCall
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

      if (
        result.status === 'ok' &&
        approvedCall &&
        session.conversationId &&
        this.#changeHistory
      ) {
        await this.#changeHistory
          .record({
            conversationId: session.conversationId,
            workspace: session.workspace,
            approvedCall,
            diff: approvedDiff,
          })
          .catch((error: unknown) =>
            this.#onDiagnostic('Failed to persist file change history', error),
          )
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
}
