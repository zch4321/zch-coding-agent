import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PolicySignal } from '../../shared/agent-events'
import type {
  PermissionMode,
  PublicConfig,
  RememberedRule,
} from '../../shared/config'
import type { RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { BeforeToolCallEmitResult } from '../plugins/types'
import {
  approvedCallBrand,
  type ApprovedBy,
  type ApprovedToolCall,
} from '../tools/approved-tool-call'
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types'
import {
  autoApproverInput,
  type AutoApprover,
  type AutoApproverResult,
} from './auto-approver'
import { prepareToolResourcePlan } from '../tools/file-tools'
import type { ToolResourcePlan } from '../tools/file-tool-types'
import { PathGuardError } from '../safety/path-guard'
import { evaluatePolicy } from './policy-engine'
import type { SessionTempPaths } from '../session-temp/service'

export interface ApprovalRequest {
  call: ToolCall
  policySignals: PolicySignal[]
  expiresAt: string
  rememberable: boolean
  rememberArgConstraints?: JsonValue
}

export interface RememberApprovalInput {
  workspaceScope: 'workspace' | 'global'
  expiresAt?: string
}

export interface HumanApprovalDecision {
  decision: 'allow' | 'deny' | 'cancelled'
  remember?: RememberApprovalInput
}

export type AuthorizationResult =
  | {
      ok: true
      approvedCall: ApprovedToolCall
      policySignals: PolicySignal[]
      rememberedRule?: RememberedRule
      autoDecision?: AutoApproverResult
    }
  | {
      ok: false
      result: ToolResult
      policySignals: PolicySignal[]
      autoDecision?: AutoApproverResult
    }

export interface PermissionPipelineInput {
  sessionId: SessionId
  runId: RunId
  workspace: string
  sessionTemp?: SessionTempPaths
  mode: PermissionMode
  call: ToolCall
  definition: ToolDefinition
  config: PublicConfig
  signal: AbortSignal
  autoApprover?: AutoApprover
  beforeToolCall?: (
    currentRisk: ToolDefinition['defaultRisk'],
  ) => Promise<BeforeToolCallEmitResult | undefined>
  requestHumanApproval: (
    request: ApprovalRequest,
  ) => Promise<HumanApprovalDecision>
}

function freezeDeep<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)

    for (const nested of Object.values(value)) {
      freezeDeep(nested)
    }
  }

  return value
}

/** Hashes tool arguments so an approval is bound to the exact call payload. */
export function createArgsHash(args: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

function issueApprovedCall(input: {
  sessionId: SessionId
  runId: RunId
  workspace: string
  sessionTempRoot?: string
  call: ToolCall
  approvedBy: ApprovedBy
}): ApprovedToolCall {
  const approved = {
    [approvedCallBrand]: true,
    sessionId: input.sessionId,
    runId: input.runId,
    callId: input.call.id,
    toolId: input.call.toolId,
    args: structuredClone(input.call.args),
    argsHash: createArgsHash(input.call.args),
    workspace: path.resolve(input.workspace),
    ...(input.sessionTempRoot
      ? { sessionTempRoot: path.resolve(input.sessionTempRoot) }
      : {}),
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
  } as ApprovedToolCall

  return freezeDeep(approved)
}

function structuredFailure(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error instanceof PathGuardError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'INVALID_TOOL_CALL',
    message:
      error instanceof Error ? error.message : 'Tool invariants were rejected',
    retryable: false,
  }
}

function raisedRisk(
  base: ToolDefinition['defaultRisk'],
  hook: BeforeToolCallEmitResult | undefined,
): ToolDefinition['defaultRisk'] {
  if (!hook || hook.risk === 'unchanged') {
    return base
  }

  if (hook.risk === 'high' || base === 'high') {
    return 'high'
  }

  return base === 'low' ? 'review' : base
}

function hookSignals(
  hook: BeforeToolCallEmitResult | undefined,
): PolicySignal[] {
  if (!hook || hook.risk === 'unchanged') {
    return []
  }

  return [
    {
      code: 'plugin_risk_raise',
      severity: hook.risk === 'high' ? 'danger' : 'warning',
      detail: hook.reason ?? `A security hook raised risk to ${hook.risk}`,
    },
  ]
}

function autoSignals(result: AutoApproverResult): PolicySignal[] {
  return [
    {
      code: result.valid
        ? 'auto_approver_dangerous'
        : `auto_approver_${result.failure ?? 'invalid'}`,
      severity: 'danger',
      detail: result.note,
    },
  ]
}

function rememberArgConstraints(call: ToolCall): JsonValue | undefined {
  const args = call.args

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined
  }

  if (
    call.toolId === 'write_file' ||
    call.toolId === 'apply_patch' ||
    call.toolId === 'delete_file'
  ) {
    return typeof args.path === 'string' ? { path: args.path } : undefined
  }

  if (call.toolId === 'run_command' && args.mode === 'process') {
    if (typeof args.executable !== 'string') {
      return undefined
    }

    return {
      mode: 'process',
      executable: args.executable,
      ...(Array.isArray(args.args) ? { args: structuredClone(args.args) } : {}),
      ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
    }
  }

  if (call.toolId === 'git_add') {
    return {
      ...(args.all === true ? { all: true } : {}),
      ...(Array.isArray(args.paths)
        ? { paths: structuredClone(args.paths) }
        : {}),
    }
  }

  if (call.toolId === 'git_restore') {
    return {
      ...(args.staged === true ? { staged: true } : {}),
      ...(Array.isArray(args.paths)
        ? { paths: structuredClone(args.paths) }
        : {}),
    }
  }

  // git_commit is intentionally not rememberable: auto-committing on a rule
  // would create history without a per-call decision.
  return undefined
}

function rememberedRule(input: {
  call: ToolCall
  workspace: string
  remember: RememberApprovalInput
  argConstraints: JsonValue
}): RememberedRule {
  return {
    id: `rule:${randomUUID()}`,
    effect: 'allow',
    toolId: input.call.toolId,
    workspaceScope:
      input.remember.workspaceScope === 'global' ? '*' : input.workspace,
    argConstraints: structuredClone(input.argConstraints),
    expiresAt: input.remember.expiresAt,
    createdFromCallId: input.call.id,
  }
}

function comparablePath(value: string | undefined): string | undefined {
  if (!value) return undefined
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Checks that an approved call still matches its owner, arguments, and filesystem scope. */
export function revalidateApprovedToolCall(
  approvedCall: ApprovedToolCall,
  context: {
    sessionId: SessionId
    runId: RunId
    workspace: string
    sessionTempRoot?: string
  },
): void {
  if (approvedCall[approvedCallBrand] !== true) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Tool execution requires an ApprovedToolCall issued by the permission pipeline',
    )
  }

  if (
    approvedCall.sessionId !== context.sessionId ||
    approvedCall.runId !== context.runId
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call ownership does not match the execution context',
    )
  }

  if (approvedCall.argsHash !== createArgsHash(approvedCall.args)) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call arguments changed before execution',
    )
  }

  if (
    comparablePath(approvedCall.workspace) !==
      comparablePath(context.workspace) ||
    comparablePath(approvedCall.sessionTempRoot) !==
      comparablePath(context.sessionTempRoot)
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call filesystem scope changed before execution',
    )
  }
}

/** Applies policy, plugin, auto-approval, and human-approval gates to tool calls. */
export class PermissionPipeline {
  /** Resolves the resource plan and returns an allow, deny, or approval-required outcome. */
  async authorize(
    input: PermissionPipelineInput,
  ): Promise<AuthorizationResult> {
    let plan: ToolResourcePlan

    try {
      plan = await prepareToolResourcePlan({
        workspace: input.workspace,
        sessionTemp: input.sessionTemp,
        call: input.call,
        definition: input.definition,
        limits: input.config.limits,
      })
    } catch (error) {
      return {
        ok: false,
        result: structuredFailure(error),
        policySignals: [],
      }
    }

    const hook = await input.beforeToolCall?.(input.definition.defaultRisk)

    if (hook && !hook.allow) {
      return {
        ok: false,
        result: {
          status: 'denied',
          message: hook.reason ?? 'A security hook blocked this tool call',
        },
        policySignals: [
          ...plan.policySignals,
          {
            code: 'plugin_blocked',
            severity: 'danger',
            detail: hook.reason ?? 'A security hook blocked this tool call',
          },
        ],
      }
    }

    let signals = [...plan.policySignals, ...hookSignals(hook)]

    if (!input.call.reason.trim()) {
      signals.push({
        code: 'missing_reason',
        severity: 'warning',
        detail: 'The provider did not supply a reason for this tool call',
      })
    }

    const outcome = evaluatePolicy({
      mode: input.mode,
      definition: input.definition,
      effectiveRisk: raisedRisk(input.definition.defaultRisk, hook),
      policySignals: signals,
      rememberedRules: input.config.permission.rememberedRules,
      builtinPolicies: input.config.permission.builtinPolicies,
      workspace: input.workspace,
      args: input.call.args,
      callId: input.call.id,
      scratchMutation: plan.scratchMutation === true,
    })

    if (outcome.kind === 'deny') {
      return {
        ok: false,
        result: { status: 'denied', message: outcome.reason },
        policySignals: signals,
      }
    }

    if (outcome.kind === 'allow') {
      return {
        ok: true,
        approvedCall: issueApprovedCall({
          sessionId: input.sessionId,
          runId: input.runId,
          workspace: input.workspace,
          sessionTempRoot: input.sessionTemp?.root,
          call: input.call,
          approvedBy: outcome.approvedBy,
        }),
        policySignals: signals,
      }
    }

    let autoDecision: AutoApproverResult | undefined
    let reviewReason = outcome.reason

    if (outcome.kind === 'model') {
      autoDecision = input.autoApprover
        ? await input.autoApprover.evaluate(
            autoApproverInput({
              call: input.call,
              definition: input.definition,
              workspace: input.workspace,
              policySignals: signals,
            }),
            input.signal,
          )
        : {
            decision: 'dangerous',
            note: 'Approval model is unavailable',
            valid: false,
            failure: 'network',
          }

      if (autoDecision.decision === 'safe' && autoDecision.valid) {
        return {
          ok: true,
          approvedCall: issueApprovedCall({
            sessionId: input.sessionId,
            runId: input.runId,
            workspace: input.workspace,
            sessionTempRoot: input.sessionTemp?.root,
            call: input.call,
            approvedBy: 'model',
          }),
          policySignals: signals,
          autoDecision,
        }
      }

      signals = [...signals, ...autoSignals(autoDecision)]
      reviewReason = autoDecision.note
    }

    const rememberConstraints = rememberArgConstraints(input.call)
    const decision = await input.requestHumanApproval({
      call: input.call,
      policySignals: signals,
      expiresAt: new Date(
        Date.now() + input.config.limits.approvalTimeoutMs,
      ).toISOString(),
      rememberable: rememberConstraints !== undefined,
      rememberArgConstraints: rememberConstraints,
    })

    if (decision.decision === 'cancelled') {
      return {
        ok: false,
        result: { status: 'cancelled', message: 'Approval was cancelled' },
        policySignals: signals,
        autoDecision,
      }
    }

    if (decision.decision === 'deny') {
      return {
        ok: false,
        result: { status: 'denied', message: reviewReason },
        policySignals: signals,
        autoDecision,
      }
    }

    const rule =
      decision.remember && rememberConstraints
        ? rememberedRule({
            call: input.call,
            workspace: input.workspace,
            remember: decision.remember,
            argConstraints: rememberConstraints,
          })
        : undefined

    return {
      ok: true,
      approvedCall: issueApprovedCall({
        sessionId: input.sessionId,
        runId: input.runId,
        workspace: input.workspace,
        sessionTempRoot: input.sessionTemp?.root,
        call: input.call,
        approvedBy: 'human',
      }),
      policySignals: signals,
      rememberedRule: rule,
      autoDecision,
    }
  }
}
