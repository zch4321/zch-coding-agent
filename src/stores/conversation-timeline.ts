import type { MessageId, RunId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type {
  ChatMessage,
  ConversationTurn,
  ReasoningSegment,
  ToolActivity,
} from './agent-types'
import type { SessionOverlay } from './agent-runtime-helpers'
import { TODO_TOOL_ID } from '../../shared/todo'
import {
  messageText,
  originalUserRecord,
  resolveRunActivity,
} from './agent-runtime-helpers'

interface TimelineProjectionInput {
  records: readonly MessageRecord[]
  overlay?: SessionOverlay
}

interface MutableConversationTurn extends ConversationTurn {
  sourceTurnId?: MessageId
}

function createTurn(input: {
  id: string
  order: number
  sourceTurnId?: MessageId
  userMessage?: ChatMessage
}): MutableConversationTurn {
  return {
    id: input.id,
    order: input.order,
    sourceTurnId: input.sourceTurnId,
    userMessage: input.userMessage,
    tools: [],
    reasoningSegments: [],
    messages: [],
  }
}

function recordRoleMessage(record: MessageRecord): ChatMessage {
  if (record.kind !== 'orchestrator' && record.kind !== 'interjection') {
    throw new TypeError(
      'Timeline role records must be orchestrator or interjection messages',
    )
  }
  return {
    id: record.id,
    role: record.kind,
    durableKind: record.kind,
    text: messageText(record),
    order: record.seq,
    ...(record.kind === 'interjection' && record.metadata?.interjectionId
      ? { interjectionId: record.metadata.interjectionId }
      : {}),
  }
}

function isInternalSwarmOrchestration(record: MessageRecord): boolean {
  return (
    record.kind === 'orchestrator' &&
    record.metadata !== undefined &&
    'layer' in record.metadata &&
    record.metadata.layer.source === 'slash:/swarm'
  )
}

function userChatMessage(
  record: Extract<MessageRecord, { kind: 'user_input' }>,
): ChatMessage {
  return {
    id: record.id,
    role: 'user',
    durableKind: 'user_input',
    text: messageText(record),
    order: record.seq,
    attachments: originalUserRecord(record)
      ? record.metadata.attachments
      : undefined,
    retryable: true,
    editable: true,
  }
}

function liveInterjectionMessage(
  interjection: SessionOverlay['interjections'][number],
  runId: RunId,
  order: number,
): ChatMessage {
  return {
    id: `interjection:${interjection.id}`,
    role: 'interjection',
    durableKind: 'interjection',
    runId,
    text: interjection.content,
    order,
    interjectionId: interjection.id,
    interjectionStatus: interjection.status,
    live: true,
  }
}

function sortTurnContent(turn: MutableConversationTurn): void {
  turn.tools.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  turn.reasoningSegments.sort((left, right) => left.order - right.order)
  turn.messages.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
}

function copyTodo(todo: NonNullable<SessionOverlay['todo']>) {
  return {
    ...(todo.explanation === undefined
      ? {}
      : { explanation: todo.explanation }),
    items: todo.items.map((item) => ({ ...item })),
  }
}

function markFinalAssistantMessages(turns: MutableConversationTurn[]): void {
  const finalBySourceTurn = new Map<
    string,
    { turn: MutableConversationTurn; messageId: string }
  >()

  for (const turn of turns) {
    const sourceTurnId = turn.sourceTurnId ?? turn.id
    for (const message of turn.messages) {
      if (
        message.role === 'assistant' &&
        message.durableKind === 'assistant_turn'
      ) {
        finalBySourceTurn.set(sourceTurnId, {
          turn,
          messageId: message.id,
        })
      }
    }
  }

  for (const { turn, messageId } of finalBySourceTurn.values()) {
    turn.finalAssistantMessageId = messageId
  }
}

/** Projects canonical records and the live overlay into user-visible conversation turns. */
export function projectConversationTurns({
  records,
  overlay,
}: TimelineProjectionInput): ConversationTurn[] {
  const turns: MutableConversationTurn[] = []
  const phaseBySourceTurnId = new Map<string, MutableConversationTurn>()
  const aliases = new Map<string, string>()
  const toolsByCallId = new Map<string, ToolActivity>()
  const hiddenToolCallIds = new Set<string>()
  const durableInterjectionIds = new Set<string>()
  let currentTurn: MutableConversationTurn | undefined

  const resolveAlias = (value: string): string => {
    const seen = new Set<string>()
    let resolved = value
    while (aliases.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved)
      resolved = aliases.get(resolved)!
    }
    return resolved
  }

  const ensureTurn = (record: MessageRecord): MutableConversationTurn => {
    const rawSourceTurnId = record.turnId ?? record.id
    const sourceTurnId = resolveAlias(rawSourceTurnId)
    const existing = phaseBySourceTurnId.get(sourceTurnId)
    if (existing) {
      currentTurn = existing
      return existing
    }
    const turn = createTurn({
      id: `turn:${sourceTurnId}:continuation`,
      order: record.seq,
      sourceTurnId: sourceTurnId as MessageId,
    })
    turns.push(turn)
    phaseBySourceTurnId.set(sourceTurnId, turn)
    currentTurn = turn
    return turn
  }

  for (const record of [...records].sort(
    (left, right) => left.seq - right.seq,
  )) {
    if (isInternalSwarmOrchestration(record)) continue

    if (record.kind === 'user_input' && record.visibility !== 'visible') {
      if ('replayedFromMessageId' in record.metadata) {
        aliases.set(
          record.id,
          resolveAlias(record.metadata.replayedFromMessageId),
        )
      } else if ('derivedFromMessageId' in record.metadata) {
        aliases.set(
          record.id,
          currentTurn?.sourceTurnId ??
            (resolveAlias(record.metadata.derivedFromMessageId) as MessageId),
        )
      }
      continue
    }
    if (record.visibility !== 'visible') continue

    if (record.kind === 'user_input' && originalUserRecord(record)) {
      const sourceTurnId = resolveAlias(record.turnId ?? record.id) as MessageId
      currentTurn = createTurn({
        id: `turn:${record.id}`,
        order: record.seq,
        sourceTurnId,
        userMessage: userChatMessage(record),
      })
      turns.push(currentTurn)
      phaseBySourceTurnId.set(sourceTurnId, currentTurn)
      continue
    }

    if (record.kind === 'interjection') {
      const sourceTurnId = resolveAlias(record.turnId ?? record.id) as MessageId
      const message = recordRoleMessage(record)
      if (message.interjectionId)
        durableInterjectionIds.add(message.interjectionId)
      currentTurn = createTurn({
        id: `turn:${sourceTurnId}:interjection:${record.id}`,
        order: record.seq,
        sourceTurnId,
        userMessage: message,
      })
      turns.push(currentTurn)
      phaseBySourceTurnId.set(sourceTurnId, currentTurn)
      continue
    }

    const turn = ensureTurn(record)
    if (record.kind === 'orchestrator') {
      turn.messages.push(recordRoleMessage(record))
      continue
    }
    if (record.kind === 'assistant_turn') {
      const reasoning = record.normalizedReasoningText?.trim()
      if (reasoning) {
        turn.reasoningSegments.push({
          id: `${record.id}:reasoning`,
          text: record.normalizedReasoningText!,
          order: record.seq,
        })
      }
      const text = messageText(record)
      if (text.trim()) {
        turn.messages.push({
          id: record.id,
          role: 'assistant',
          durableKind: 'assistant_turn',
          text,
          order: record.seq,
        })
      }
      for (const part of record.parts) {
        if (part.type !== 'tool_call') continue
        if (part.name === TODO_TOOL_ID) {
          hiddenToolCallIds.add(part.callId)
          continue
        }
        const tool: ToolActivity = {
          callId: part.callId,
          runId: (record.turnId ?? record.id) as unknown as RunId,
          tool: part.name,
          args: part.arguments,
          reason: '',
          status: 'proposed',
          order: record.seq,
        }
        turn.tools.push(tool)
        toolsByCallId.set(part.callId, tool)
      }
      continue
    }
    if (record.kind === 'tool_result') {
      const part = record.parts[0]
      if (
        hiddenToolCallIds.has(part.callId) ||
        record.metadata?.tool.name === TODO_TOOL_ID
      ) {
        continue
      }
      let tool = toolsByCallId.get(part.callId)
      if (!tool) {
        tool = {
          callId: part.callId,
          runId: (record.turnId ?? record.id) as unknown as RunId,
          tool: record.metadata?.tool.name ?? 'unknown',
          args: {},
          reason: record.metadata?.tool.reason ?? '',
          status: 'completed',
          result: part,
          order: record.seq,
        }
        turn.tools.push(tool)
        toolsByCallId.set(part.callId, tool)
      } else {
        tool.status = 'completed'
        tool.result = part
        tool.reason = record.metadata?.tool.reason ?? tool.reason
      }
    }
  }

  if (overlay?.runId) {
    let liveTurn = currentTurn
    if (!liveTurn) {
      liveTurn = createTurn({
        id: `turn:live:${overlay.runId}`,
        order: Number.MAX_SAFE_INTEGER,
      })
      turns.push(liveTurn)
      currentTurn = liveTurn
    }

    for (const [index, interjection] of overlay.interjections.entries()) {
      if (durableInterjectionIds.has(interjection.id)) continue
      const message = liveInterjectionMessage(
        interjection,
        overlay.runId,
        Number.MAX_SAFE_INTEGER - overlay.interjections.length + index,
      )
      if (interjection.status === 'injected') {
        liveTurn = createTurn({
          id: `turn:live:${overlay.runId}:interjection:${interjection.id}`,
          order: message.order ?? Number.MAX_SAFE_INTEGER,
          sourceTurnId: currentTurn?.sourceTurnId,
          userMessage: message,
        })
        turns.push(liveTurn)
      } else {
        liveTurn.messages.push(message)
      }
    }

    const liveTools = overlay.tools
      .filter((tool) => tool.tool !== TODO_TOOL_ID)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    for (const [index, tool] of liveTools.entries()) {
      if (toolsByCallId.has(tool.callId)) continue
      const liveTool = {
        ...tool,
        order: Number.MAX_SAFE_INTEGER - liveTools.length + index,
        live: true,
      }
      liveTurn.tools.push(liveTool)
      toolsByCallId.set(tool.callId, liveTool)
    }
    if (overlay.reasoning.trim()) {
      const reasoning: ReasoningSegment = {
        id: `stream:${overlay.runId}:reasoning`,
        runId: overlay.runId,
        text: overlay.reasoning,
        order: Number.MAX_SAFE_INTEGER - 1,
        live: true,
      }
      liveTurn.reasoningSegments.push(reasoning)
    }
    if (overlay.text.trim()) {
      liveTurn.messages.push({
        id: `stream:${overlay.runId}`,
        role: 'assistant',
        durableKind: 'stream',
        runId: overlay.runId,
        text: overlay.text,
        order: Number.MAX_SAFE_INTEGER,
        live: true,
      })
    }
    liveTurn.todo = overlay.todo ? copyTodo(overlay.todo) : undefined
    liveTurn.runActivity = resolveRunActivity(overlay)
  }

  for (const turn of turns) sortTurnContent(turn)
  const visibleTurns = turns.filter(
    (turn) =>
      turn.userMessage ||
      turn.tools.length > 0 ||
      turn.reasoningSegments.length > 0 ||
      turn.messages.length > 0 ||
      turn.todo ||
      turn.runActivity,
  )
  markFinalAssistantMessages(visibleTurns)
  return visibleTurns
}
