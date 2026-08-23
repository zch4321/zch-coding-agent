import {
  MAX_RUNTIME_INTERJECTIONS,
  MAX_RUNTIME_TEXT_LENGTH,
  MAX_RUNTIME_TOOL_RECORDS,
} from '../../shared/durable'
import type { ActiveRun, AgentEventDraft } from './session-types'

function boundedRuntimeText(current: string, delta: string): string {
  const combined = current + delta
  return combined.length <= MAX_RUNTIME_TEXT_LENGTH
    ? combined
    : combined.slice(-MAX_RUNTIME_TEXT_LENGTH)
}

/** Applies an agent event's live text, reasoning, usage, and status fields to the public run snapshot. */
export function updatePublicRunSnapshot(
  run: ActiveRun,
  event: AgentEventDraft,
): void {
  const snapshot = run.publicSnapshot
  if (event.type === 'run.status') {
    if (event.status === 'calling_llm' && snapshot.status !== 'calling_llm') {
      snapshot.text = ''
      snapshot.reasoning = ''
    }
    snapshot.status = event.status
    delete snapshot.providerRetry
  } else if (event.type === 'assistant.activity') {
    delete snapshot.providerRetry
  } else if (event.type === 'assistant.text.delta') {
    delete snapshot.providerRetry
    snapshot.text = boundedRuntimeText(snapshot.text, event.delta)
  } else if (event.type === 'assistant.reasoning.delta') {
    delete snapshot.providerRetry
    snapshot.reasoning = boundedRuntimeText(snapshot.reasoning, event.delta)
  } else if (event.type === 'assistant.stream.reset') {
    snapshot.text = ''
    snapshot.reasoning = ''
  } else if (event.type === 'provider.retrying') {
    snapshot.providerRetry = structuredClone(event.retry)
  } else if (event.type === 'assistant.message.completed') {
    delete snapshot.providerRetry
    snapshot.text = event.text.slice(-MAX_RUNTIME_TEXT_LENGTH)
    snapshot.reasoning = (event.reasoning ?? '').slice(-MAX_RUNTIME_TEXT_LENGTH)
  } else if (event.type === 'tool.proposed') {
    if (
      !run.publicTools.has(event.callId) &&
      run.publicTools.size >= MAX_RUNTIME_TOOL_RECORDS
    ) {
      const oldest = run.publicTools.keys().next().value
      if (oldest !== undefined) run.publicTools.delete(oldest)
    }
    run.publicTools.set(event.callId, {
      callId: event.callId,
      tool: event.tool,
      status: 'proposed',
      arguments: structuredClone(event.args),
    })
  } else if (event.type === 'approval.requested') {
    snapshot.approval = {
      callId: event.callId,
      kind: event.kind,
      tool: event.tool,
      arguments: structuredClone(event.args),
      reason: event.reason,
      policySignals: structuredClone(event.policySignals),
      ...(event.diff ? { diff: event.diff } : {}),
      ...(event.diffHash ? { diffHash: event.diffHash } : {}),
      rememberable: event.rememberable,
      ...(event.rememberArgConstraints
        ? {
            rememberArgConstraints: structuredClone(
              event.rememberArgConstraints,
            ),
          }
        : {}),
      expiresAt: event.expiresAt,
    }
    const tool = run.publicTools.get(event.callId)
    if (tool) tool.status = 'awaiting_approval'
  } else if (event.type === 'tool.attempt' && event.stage === 'execution') {
    const tool = run.publicTools.get(event.callId)
    if (tool) tool.status = 'running'
  } else if (event.type === 'tool.completed') {
    const tool = run.publicTools.get(event.callId)
    if (tool) {
      tool.status = 'completed'
      tool.result = structuredClone(event.result)
    }
    if (snapshot.approval?.callId === event.callId) {
      delete snapshot.approval
    }
  } else if (event.type === 'interjection.updated') {
    const next = snapshot.interjections.filter(
      (item) => item.id !== event.interjectionId,
    )
    next.push({
      id: event.interjectionId,
      status: event.status,
      content: event.content,
      createdAt: event.createdAt,
    })
    snapshot.interjections = next.slice(-MAX_RUNTIME_INTERJECTIONS)
  } else if (event.type === 'todo.updated') {
    snapshot.todo = structuredClone(event.todo)
  }
  snapshot.tools = [...run.publicTools.values()].map((tool) =>
    structuredClone(tool),
  )
}
