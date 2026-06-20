import { createHash, randomUUID } from 'node:crypto'
import type { PolicySignal } from '../../shared/agent-events'
import type {
  PermissionMode,
  PublicConfig,
  RememberedRule,
} from '../../shared/config'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { BeforeToolCallEmitResult } from '../plugins/types'
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types'
import {
  autoApproverInput,
  type AutoApprover,
  type AutoApproverResult,
} from './auto-approver'
import {
  prepareToolResourcePlan,
  revalidateResourcePreconditions,
  type FilePrecondition,
  type ToolResourcePlan,
} from './file-tools'
import { PathGuardError } from './path-guard'
import { evaluatePolicy } from './policy-engine'

const approvedCallBrand: unique symbol = Symbol('ApprovedToolCall')

export type ApprovedBy =
  | 'readonly'
  | 'policy'
  | 'model'
  | 'human'
  | 'remembered'
  | 'yolo'

export interface ApprovedToolCall {
  readonly [approvedCallBrand]: true
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly callId: CallId
  readonly toolId: string
  readonly args: JsonValue
  readonly argsHash: string
  readonly resourcePreconditions: readonly FilePrecondition[]
  readonly diffHash?: string
  readonly approvedBy: ApprovedBy
  readonly approvedAt: string
}

export interface ApprovalRequest {
  call: ToolCall
  policySignals: PolicySignal[]
  diff?: string
  diffHash?: string
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
      diff?: string
      rememberedRule?: RememberedRule
      autoDecision?: AutoApproverResult
    }
  | {
      ok: false
      result: ToolResult
      policySignals: PolicySignal[]
      diff?: string
      autoDecision?: AutoApproverResult
    }

export interface PermissionPipelineInput {
  sessionId: SessionId
  runId: RunId
  workspace: string
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

export function createArgsHash(args: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

function issueApprovedCall(input: {
  sessionId: SessionId
  runId: RunId
  call: ToolCall
  plan: ToolResourcePlan
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
    resourcePreconditions: structuredClone(input.plan.preconditions),
    diffHash: input.plan.diffHash,
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

export async function revalidateApprovedToolCall(
  approvedCall: ApprovedToolCall,
  context: {
    sessionId: SessionId
    runId: RunId
    workspace: string
  },
): Promise<void> {
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

  await revalidateResourcePreconditions(
    context.workspace,
    approvedCall.resourcePreconditions,
  )
}

export class PermissionPipeline {
  async authorize(
    input: PermissionPipelineInput,
  ): Promise<AuthorizationResult> {
    let plan: ToolResourcePlan

    try {
      plan = await prepareToolResourcePlan({
        workspace: input.workspace,
        call: input.call,
        definition: input.definition,
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
        diff: plan.diff,
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
    })

    if (outcome.kind === 'deny') {
      return {
        ok: false,
        result: { status: 'denied', message: outcome.reason },
        policySignals: signals,
        diff: plan.diff,
      }
    }

    if (outcome.kind === 'allow') {
      return {
        ok: true,
        approvedCall: issueApprovedCall({
          sessionId: input.sessionId,
          runId: input.runId,
          call: input.call,
          plan,
          approvedBy: outcome.approvedBy,
        }),
        policySignals: signals,
        diff: plan.diff,
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
            call: input.call,
            plan,
            approvedBy: 'model',
          }),
          policySignals: signals,
          diff: plan.diff,
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
      diff: plan.diff,
      diffHash: plan.diffHash,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      rememberable: rememberConstraints !== undefined,
      rememberArgConstraints: rememberConstraints,
    })

    if (decision.decision === 'cancelled') {
      return {
        ok: false,
        result: { status: 'cancelled', message: 'Approval was cancelled' },
        policySignals: signals,
        diff: plan.diff,
        autoDecision,
      }
    }

    if (decision.decision === 'deny') {
      return {
        ok: false,
        result: { status: 'denied', message: reviewReason },
        policySignals: signals,
        diff: plan.diff,
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
        call: input.call,
        plan,
        approvedBy: 'human',
      }),
      policySignals: signals,
      diff: plan.diff,
      rememberedRule: rule,
      autoDecision,
    }
  }
}
