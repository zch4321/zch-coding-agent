import { randomUUID } from 'node:crypto'
import { Type, type Static } from '@sinclair/typebox'
import type { ToolRegistrationPort, ToolResult } from '../tools/types'
import type { RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { AgentEventDraft, SessionState } from './session-types'

const EmptySchema = Type.Object({}, { additionalProperties: false })
const GoalCompleteSchema = Type.Object(
  {
    summary: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description: 'Concise summary of the completed goal and final outcome.',
    }),
    evidence: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description:
        'Concrete evidence that the goal is complete, such as files changed, tests run, or observed results.',
    }),
    remainingRisks: Type.Optional(
      Type.String({
        maxLength: 65_536,
        description: 'Known residual risks, limitations, or unverified areas.',
      }),
    ),
    cancelOpenPlan: Type.Optional(
      Type.Boolean({
        description:
          'Set true only when open plan items remain and should be cancelled because the goal is already complete.',
      }),
    ),
  },
  { additionalProperties: false },
)
const GoalBlockSchema = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description: 'Why progress is blocked.',
    }),
    requiredInput: Type.String({
      minLength: 1,
      maxLength: 65_536,
      description:
        'Specific user input or external state change required to continue.',
    }),
  },
  { additionalProperties: false },
)
const PlanSetSchema = Type.Object(
  {
    objective: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 16_384,
        description:
          'Optional top-level objective for the plan. Omit to keep the previous objective or use a generic title.',
      }),
    ),
    items: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description:
          'One concrete, checkable plan item. Use imperative task text, not status labels.',
      }),
      {
        minItems: 1,
        maxItems: 256,
        description:
          'Ordered list of concrete plan items. Calling plan_set puts the plan into awaiting_review.',
      },
    ),
  },
  { additionalProperties: false },
)
const PlanItemIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  description:
    'Plan item id exactly as returned by plan_get or a previous plan_set call, for example item:1.',
})
const PlanItemResultSchema = Type.String({
  minLength: 1,
  maxLength: 65_536,
  description:
    'Outcome of the item. Required when status is completed; optional otherwise.',
})
const PlanItemEvidenceSchema = Type.String({
  minLength: 1,
  maxLength: 65_536,
  description:
    'Concrete evidence for the item result. Required when status is completed; optional otherwise.',
})
const PlanUpdateSchema = Type.Unsafe<{
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
  result?: string
  evidence?: string
}>({
  type: 'object',
  properties: {
    id: PlanItemIdSchema,
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
      description:
        'New item status. Use completed only with result and evidence.',
    },
    result: PlanItemResultSchema,
    evidence: PlanItemEvidenceSchema,
  },
  required: ['id', 'status'],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: {
          status: { const: 'completed' },
        },
        required: ['status'],
      },
      then: {
        properties: {
          result: PlanItemResultSchema,
          evidence: PlanItemEvidenceSchema,
        },
        required: ['result', 'evidence'],
      },
    },
  ],
})
const PlanStatusUpdateSchema = Type.Object(
  {
    status: Type.Union(
      [
        Type.Literal('awaiting_review'),
        Type.Literal('active'),
        Type.Literal('rejected'),
        Type.Literal('completed'),
      ],
      {
        description:
          'Top-level plan status. Use active only after explicit user approval; completed requires all items completed or cancelled.',
      },
    ),
  },
  { additionalProperties: false },
)

function now(): string {
  return new Date().toISOString()
}

function ok(content: unknown): ToolResult {
  return { status: 'ok', content: content as JsonValue }
}

function error(message: string): ToolResult {
  return {
    status: 'error',
    code: 'ORCHESTRATION_STATE',
    message,
    retryable: true,
  }
}

function openPlanItems(session: SessionState) {
  return (session.plan?.items ?? []).filter(
    (item) => item.status !== 'completed' && item.status !== 'cancelled',
  )
}

function emitGoal(
  session: SessionState,
  emit: (session: SessionState, event: AgentEventDraft) => void,
  runId: RunId,
): void {
  emit(session, {
    type: 'goal.updated',
    sessionId: session.sessionId,
    runId,
    goal: session.goal ? structuredClone(session.goal) : undefined,
  })
}

function emitPlan(
  session: SessionState,
  emit: (session: SessionState, event: AgentEventDraft) => void,
  runId: RunId,
): void {
  emit(session, {
    type: 'plan.updated',
    sessionId: session.sessionId,
    runId,
    plan: session.plan ? structuredClone(session.plan) : undefined,
  })
}

function requireSession(
  getSession: (sessionId: SessionId) => SessionState | undefined,
  sessionId: SessionId,
): SessionState | ToolResult {
  return getSession(sessionId) ?? error('Session was not found')
}

export function registerOrchestrationTools(
  registry: ToolRegistrationPort,
  options: {
    getSession: (sessionId: SessionId) => SessionState | undefined
    emit: (session: SessionState, event: AgentEventDraft) => void
  },
): void {
  registry.registerTool({
    id: 'goal_get',
    description: 'Read the active Goal state for this conversation.',
    inputSchema: EmptySchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 16 * 1_024,
    async execute(_args, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      return ok({ goal: session.goal ?? null })
    },
  })

  registry.registerTool({
    id: 'goal_complete',
    description:
      'Mark the active Goal completed. Provide summary, evidence, and remaining risks. If plan items remain open, cancelOpenPlan must be true.',
    inputSchema: GoalCompleteSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 16 * 1_024,
    async execute(args: Static<typeof GoalCompleteSchema>, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      if (!session.goal || session.goal.status !== 'active') {
        return error('No active Goal exists')
      }

      const openItems = openPlanItems(session)
      if (openItems.length > 0 && !args.cancelOpenPlan) {
        return error(
          'Open plan items remain. Complete/cancel them, or call goal_complete with cancelOpenPlan=true and explain why.',
        )
      }

      if (openItems.length > 0 && session.plan) {
        const updatedAt = now()
        session.plan.items = session.plan.items.map((item) =>
          item.status === 'completed' || item.status === 'cancelled'
            ? item
            : {
                ...item,
                status: 'cancelled',
                result:
                  item.result ?? 'Cancelled because the Goal was completed.',
                updatedAt,
              },
        )
        session.plan.updatedAt = updatedAt
        emitPlan(session, options.emit, context.runId)
      }

      session.goal = {
        ...session.goal,
        status: 'completed',
        summary: args.summary,
        evidence: args.evidence,
        remainingRisks: args.remainingRisks,
        updatedAt: now(),
      }
      emitGoal(session, options.emit, context.runId)
      return ok({ goal: session.goal })
    },
  })

  registry.registerTool({
    id: 'goal_block',
    description:
      'Mark the active Goal blocked when progress requires user input or an external state change.',
    inputSchema: GoalBlockSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 16 * 1_024,
    async execute(args: Static<typeof GoalBlockSchema>, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      if (!session.goal || session.goal.status !== 'active') {
        return error('No active Goal exists')
      }

      session.goal = {
        ...session.goal,
        status: 'blocked',
        blockReason: args.reason,
        requiredInput: args.requiredInput,
        updatedAt: now(),
      }
      emitGoal(session, options.emit, context.runId)
      return ok({ goal: session.goal })
    },
  })

  registry.registerTool({
    id: 'plan_get',
    description: 'Read the current Plan state and item statuses.',
    inputSchema: EmptySchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 32 * 1_024,
    async execute(_args, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      return ok({ plan: session.plan ?? null })
    },
  })

  registry.registerTool({
    id: 'plan_set',
    description:
      'Create or replace the current Plan with concrete items and put it in awaiting_review by default. After calling plan_set, stop for user review instead of executing the items. If the user explicitly approves the current plan later, call plan_status with status="active" and then continue execution. If the user rejects the plan, call plan_status with status="rejected".',
    inputSchema: PlanSetSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 32 * 1_024,
    async execute(args: Static<typeof PlanSetSchema>, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      const updatedAt = now()
      const objective = args.objective ?? session.plan?.objective ?? 'Plan'
      session.plan = {
        id: session.plan?.id ?? `plan:${randomUUID()}`,
        objective,
        status: 'awaiting_review',
        continuationCount: session.plan?.continuationCount ?? 0,
        createdAt: session.plan?.createdAt ?? updatedAt,
        updatedAt,
        items: args.items.map((title, index) => ({
          id: `item:${index + 1}`,
          title,
          status: 'pending',
          updatedAt,
        })),
      }
      emitPlan(session, options.emit, context.runId)
      return ok({ plan: session.plan })
    },
  })

  registry.registerTool({
    id: 'plan_status',
    description:
      'Change the top-level Plan status. Use status="awaiting_review" after creating or revising a plan that needs user approval, then stop and wait. Use status="active" only after explicit user approval, including natural-language approval like "approve", "go ahead", or "start"; after setting active, continue executing open plan items. Use status="rejected" when the user rejects or asks not to proceed; do not execute rejected plan items. Use status="completed" only after the plan is finished; complete or cancel every open item first.',
    inputSchema: PlanStatusUpdateSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 32 * 1_024,
    async execute(args: Static<typeof PlanStatusUpdateSchema>, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      if (!session.plan) return error('No Plan exists')

      const openItems = openPlanItems(session)
      if (args.status === 'completed' && openItems.length > 0) {
        return error(
          'Complete or cancel every open plan item before setting the Plan status to completed.',
        )
      }

      const previousStatus = session.plan.status ?? 'active'
      session.plan.status = args.status
      session.plan.updatedAt = now()

      if (args.status === 'active' && previousStatus !== 'active') {
        session.plan.continuationCount = 0
        delete session.plan.warning
      }

      emitPlan(session, options.emit, context.runId)
      return ok({ plan: session.plan })
    },
  })

  registry.registerTool({
    id: 'plan_update',
    description:
      'Update one Plan item. Completed items must include result and evidence.',
    inputSchema: PlanUpdateSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    maxOutputBytes: 32 * 1_024,
    async execute(args: Static<typeof PlanUpdateSchema>, context) {
      const session = requireSession(options.getSession, context.sessionId)
      if ('status' in session) return session
      if (!session.plan) return error('No active Plan exists')
      if (
        args.status === 'completed' &&
        (!args.result?.trim() || !args.evidence?.trim())
      ) {
        return error('Completed plan items require result and evidence')
      }

      const item = session.plan.items.find(
        (candidate) => candidate.id === args.id,
      )
      if (!item) return error(`Plan item not found: ${args.id}`)

      item.status = args.status
      item.result = args.result
      item.evidence = args.evidence
      item.updatedAt = now()
      session.plan.updatedAt = item.updatedAt
      emitPlan(session, options.emit, context.runId)
      return ok({ plan: session.plan })
    },
  })
}
