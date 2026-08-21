import { describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../shared/config'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { TODO_TOOL_ID } from '../../shared/todo'
import { evaluatePolicy } from '../permission/policy-engine'
import { ToolExecutor, ToolRegistry } from '../tools/tool-registry'
import type { ActiveRun, SessionState } from './session-types'
import { registerTodoTools } from './todo-tools'

const sessionId = 'session:todo' as SessionId
const runId = 'run:todo' as RunId

function fixture() {
  const run = {
    runId,
    publicSnapshot: {
      schemaVersion: 1,
      sessionId,
      runId,
      status: 'running_tools',
      text: '',
      reasoning: '',
      tools: [],
      interjections: [],
    },
  } as unknown as ActiveRun
  const session = { sessionId, activeRun: run } as SessionState
  const emit = vi.fn()
  const registry = new ToolRegistry()
  registerTodoTools(registry, {
    getSession: (candidate) => (candidate === sessionId ? session : undefined),
    emit,
  })
  return {
    run,
    session,
    emit,
    registry,
    executor: new ToolExecutor(registry),
  }
}

function context(candidateRunId = runId) {
  const controller = new AbortController()
  return {
    sessionId,
    runId: candidateRunId,
    workspace: { canonicalPath: '/workspace' },
    signal: controller.signal,
    approvedCall: {
      sessionId,
      runId: candidateRunId,
      callId: 'call:todo' as CallId,
      toolId: TODO_TOOL_ID,
      args: { items: [] },
      approvedBy: 'policy',
      approvedAt: new Date(0).toISOString(),
    } as never,
  }
}

describe('todo_update Tool', () => {
  it('publishes a bounded full-snapshot schema and remains approval-free', () => {
    const { registry } = fixture()
    const definition = registry.get(TODO_TOOL_ID)!
    const provider = registry
      .providerDefinitions()
      .find((candidate) => candidate.name === TODO_TOOL_ID)!
    const schema = provider.inputSchema as {
      properties: Record<string, unknown>
    }

    expect(definition.executionMode).toBe('serial')
    expect(definition.description).toContain('complete ordered item list')
    expect(definition.description).toContain('durable Plan')
    expect(Object.keys(schema.properties)).toEqual([
      'explanation',
      'items',
      '_agent_intent',
    ])
    for (const mode of [
      'readonly',
      'auto',
      'confirm',
      'yolo',
    ] satisfies PermissionMode[]) {
      expect(
        evaluatePolicy({
          mode,
          definition,
          effectiveRisk: definition.defaultRisk,
          policySignals: [],
          rememberedRules: [],
          builtinPolicies: true,
          workspace: '/workspace',
          args: { items: [] },
          callId: 'call:todo-policy' as CallId,
        }).kind,
      ).toBe('allow')
    }
  })

  it('rejects blank steps and more than one in-progress item', () => {
    const { executor } = fixture()
    const inspect = (items: Array<{ step: string; status: string }>) =>
      executor.inspectCall({
        id: 'call:todo-validation' as CallId,
        toolId: TODO_TOOL_ID,
        args: { items },
        reason: '',
      })

    expect(inspect([{ step: ' ', status: 'pending' }]).ok).toBe(false)
    expect(
      inspect([
        { step: 'First', status: 'in_progress' },
        { step: 'Second', status: 'in_progress' },
      ]).ok,
    ).toBe(false)
    expect(
      inspect([
        { step: 'First', status: 'completed' },
        { step: 'Second', status: 'in_progress' },
      ]).ok,
    ).toBe(true)
  })

  it('replaces the active Run snapshot and emits the normalized state', async () => {
    const { registry, run, emit } = fixture()
    const definition = registry.get(TODO_TOOL_ID)!
    const result = await definition.execute(
      {
        explanation: '  Track the implementation  ',
        items: [
          { step: '  Inspect the runtime  ', status: 'completed' },
          { step: 'Wire the event', status: 'in_progress' },
        ],
      },
      context(),
    )

    expect(run.todo).toEqual({
      explanation: 'Track the implementation',
      items: [
        { step: 'Inspect the runtime', status: 'completed' },
        { step: 'Wire the event', status: 'in_progress' },
      ],
    })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      expect.objectContaining({
        type: 'todo.updated',
        sessionId,
        runId,
        todo: run.todo,
      }),
    )
    expect(result).toEqual({
      status: 'ok',
      content: { message: 'Todo updated', completed: 1, total: 2 },
    })
  })

  it('rejects a stale Run identity without changing the active checklist', async () => {
    const { registry, run, emit } = fixture()
    const result = await registry
      .get(TODO_TOOL_ID)!
      .execute(
        { items: [{ step: 'Stale update', status: 'in_progress' }] },
        context('run:stale' as RunId),
      )

    expect(result).toMatchObject({
      status: 'error',
      code: 'TODO_RUN_MISMATCH',
      retryable: false,
    })
    expect(run.todo).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })
})
