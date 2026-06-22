import { randomUUID } from 'node:crypto'
import { Type, type Static } from '@sinclair/typebox'
import type { ToolRegistrationPort, ToolResult } from '../tools/types'
import type { RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { AgentEventDraft, SessionState } from './session-types'

const EmptySchema = Type.Object({}, { additionalProperties: false })
const GoalCompleteSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 65_536 }),
    evidence: Type.String({ minLength: 1, maxLength: 65_536 }),
    remainingRisks: Type.Optional(Type.String({ maxLength: 65_536 })),
    cancelOpenPlan: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
const GoalBlockSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 65_536 }),
    requiredInput: Type.String({ minLength: 1, maxLength: 65_536 }),
  },
  { additionalProperties: false },
)
const PlanSetSchema = Type.Object(
  {
    objective: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    items: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 256,
    }),
  },
  { additionalProperties: false },
)
const PlanUpdateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('in_progress'),
      Type.Literal('completed'),
      Type.Literal('blocked'),
      Type.Literal('cancelled'),
    ]),
    result: Type.Optional(Type.String({ maxLength: 65_536 })),
    evidence: Type.Optional(Type.String({ maxLength: 65_536 })),
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
      'Create or replace the current Plan with concrete items before executing a planned task.',
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
