import { Type, type Static } from '@sinclair/typebox'
import { AgentExecutionSummarySchema } from './agent-execution'
import {
  AgentExecutionIdSchema,
  SessionIdSchema,
  TerminalIdSchema,
} from './ids'
import { RuntimeCursorSchema } from './runtime-cursor'
import { TerminalStatusSchema } from './terminal'

export const BACKGROUND_PAGE_SIZE = 50
export const BACKGROUND_TAIL_LINES = 200
export const BACKGROUND_TAIL_BYTES = 64 * 1024

export const BackgroundTaskTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal('subagent'), Type.Literal('swarm')]),
      executionId: AgentExecutionIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('terminal'), terminalId: TerminalIdSchema },
    { additionalProperties: false },
  ),
])
export type BackgroundTaskTarget = Static<typeof BackgroundTaskTargetSchema>

export const BackgroundTerminalSchema = Type.Object(
  {
    kind: Type.Literal('terminal'),
    terminalId: TerminalIdSchema,
    shell: Type.String({ maxLength: 4096 }),
    status: TerminalStatusSchema,
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    artifactAvailable: Type.Boolean(),
    captureError: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: false },
)
export type BackgroundTerminal = Static<typeof BackgroundTerminalSchema>

export const BackgroundTaskSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('agent'), summary: AgentExecutionSummarySchema },
    { additionalProperties: false },
  ),
  BackgroundTerminalSchema,
])
export type BackgroundTask = Static<typeof BackgroundTaskSchema>

export const BackgroundTaskPageSchema = Type.Object(
  {
    cursor: RuntimeCursorSchema,
    records: Type.Array(BackgroundTaskSchema, {
      maxItems: BACKGROUND_PAGE_SIZE,
    }),
    activeCount: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
    nextBefore: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: false },
)
export type BackgroundTaskPage = Static<typeof BackgroundTaskPageSchema>

export const BackgroundTerminalTailSchema = Type.Object(
  {
    cursor: RuntimeCursorSchema,
    content: Type.String({ maxLength: BACKGROUND_TAIL_BYTES }),
    truncated: Type.Boolean(),
    available: Type.Boolean(),
    error: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: false },
)
export type BackgroundTerminalTail = Static<typeof BackgroundTerminalTailSchema>

export const BackgroundTaskEventSchema = Type.Object(
  {
    parentSessionId: SessionIdSchema,
    cursor: RuntimeCursorSchema,
  },
  { additionalProperties: false },
)
export type BackgroundTaskEvent = Static<typeof BackgroundTaskEventSchema>

/** Returns a stable key within one backend instance for a sidebar task. */
export function backgroundTaskKey(task: BackgroundTask): string {
  return task.kind === 'agent' ? task.summary.id : `terminal:${task.terminalId}`
}

/** Classifies tasks that still own running work or pending cleanup. */
export function isBackgroundTaskActive(task: BackgroundTask): boolean {
  const status = task.kind === 'agent' ? task.summary.status : task.status
  return (
    status === 'queued' ||
    status === 'preparing' ||
    status === 'running' ||
    status === 'opening' ||
    status === 'closing'
  )
}

/** Orders active tasks first, then by creation time and stable identity. */
export function compareBackgroundTasks(
  left: BackgroundTask,
  right: BackgroundTask,
): number {
  const created = (task: BackgroundTask) =>
    task.kind === 'agent' ? task.summary.createdAt : task.createdAt
  return (
    Number(isBackgroundTaskActive(right)) -
      Number(isBackgroundTaskActive(left)) ||
    created(right).localeCompare(created(left)) ||
    backgroundTaskKey(right).localeCompare(backgroundTaskKey(left))
  )
}
