import type { Static } from '@sinclair/typebox'
import type { JsonValue } from '../../shared/json'
import {
  TODO_TOOL_ID,
  TodoStateSchema,
  parseTodoState,
} from '../../shared/todo'
import type { ToolRegistrationPort, ToolResult } from '../tools/types'
import type { AgentEventDraft, SessionState } from './session-types'

function todoError(code: string, message: string): ToolResult {
  return {
    status: 'error',
    code,
    message,
    retryable: false,
  }
}

function validateTodo(
  args: Static<typeof TodoStateSchema>,
): string | undefined {
  if (args.explanation !== undefined && !args.explanation.trim()) {
    return 'Todo explanation must contain non-whitespace text'
  }
  if (args.items.some((item) => !item.step.trim())) {
    return 'Todo steps must contain non-whitespace text'
  }
  if (args.items.filter((item) => item.status === 'in_progress').length > 1) {
    return 'At most one Todo item may be in_progress'
  }
  return undefined
}

/** Registers the model-managed checklist tool against active Session execution. */
export function registerTodoTools(
  registry: ToolRegistrationPort,
  options: {
    getSession: (
      sessionId: SessionState['sessionId'],
    ) => SessionState | undefined
    emit: (session: SessionState, event: AgentEventDraft) => void
  },
): void {
  registry.registerTool({
    id: TODO_TOOL_ID,
    description:
      'Updates the current task Todo checklist. Provide an optional explanation and the complete ordered item list on every call. The latest successful update remains current in conversation history until another update replaces it. Use it for non-trivial multi-step work, keep steps short, and skip it for simple tasks. Keep at most one item in_progress and mark every item completed before finishing. This does not create or modify the durable Plan.',
    inputSchema: TodoStateSchema,
    executionMode: 'serial',
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 1_000,
    validateArgs: validateTodo,
    async execute(args: Static<typeof TodoStateSchema>, context) {
      const session = options.getSession(context.sessionId)
      if (!session) {
        return todoError('TODO_SESSION_NOT_FOUND', 'Session was not found')
      }
      const run = session.activeRun
      if (!run || run.runId !== context.runId) {
        return todoError(
          'TODO_RUN_MISMATCH',
          'Todo updates are only valid for their active Run',
        )
      }

      const todo = parseTodoState(args)
      if (!todo) {
        return todoError('TODO_INVALID', 'Todo checklist is invalid')
      }
      run.todo = todo
      options.emit(session, {
        type: 'todo.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        todo: structuredClone(todo),
      })
      return {
        status: 'ok',
        content: {
          message: 'Todo updated',
          completed: todo.items.filter((item) => item.status === 'completed')
            .length,
          total: todo.items.length,
        } as JsonValue,
      }
    },
  })
}
