import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_MESSAGE_PARTS,
  MAX_MESSAGE_TEXT_LENGTH,
} from '../../shared/durable'
import type { CallId, MessageId, SessionId } from '../../shared/ids'
import type { ContextAttachmentChip } from '../../shared/context'
import { assertBoundedJsonValue, type JsonValue } from '../../shared/json'
import {
  assertMessageRecordSemantics,
  MessageRecordSchema,
  type AssistantTurnMessageRecordSchema,
  type CanonicalPromptKind,
  type MessagePart,
  type MessageRecord,
  type ProviderCompactEnvelope,
  type ToolCallPart,
  type ToolResultContent,
} from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { Static } from '@sinclair/typebox'
import type { PromptResourceSummary } from '../prompts/registry'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

export interface CanonicalHistoryState {
  sessionId: SessionId
  history: MessageRecord[]
  nextMessageSeq: number
}

export interface CompiledCanonicalHistory {
  sessionId: SessionId
  messages: readonly MessageRecord[]
  sourceHash: string
}

export type CompletedAssistantRecord = Static<
  typeof AssistantTurnMessageRecordSchema
>

/** Rejects active history that predates canonical model-content projections. */
export class LegacyToolResultError extends TypeError {
  readonly code = 'LEGACY_TOOL_RESULT_UNSUPPORTED'

  constructor() {
    super(
      'LEGACY_TOOL_RESULT_UNSUPPORTED: This conversation contains legacy Tool Results and cannot continue; start a new conversation.',
    )
    this.name = 'LegacyToolResultError'
  }
}

const validateMessageRecord = compileSchema(MessageRecordSchema)

export interface AssistantTurnCandidateInput {
  parts: readonly MessagePart[]
  reasoning?: string
  finishReason?: string
  route: ModelRouteSnapshot
  turnId?: MessageId
  continuation?: Extract<
    MessageRecord,
    { kind: 'assistant_turn' }
  >['providerContinuation']
  usage?: CanonicalUsageInput
}

export interface CanonicalUsageInput {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheMissTokens?: number
}

function nextIdentity(state: CanonicalHistoryState) {
  const seq = state.nextMessageSeq
  state.nextMessageSeq += 1
  return {
    schemaVersion: 1 as const,
    id: `message:${randomUUID()}` as MessageId,
    sessionId: state.sessionId,
    seq,
    visibility: 'visible' as const,
    inHistory: true,
    createdAt: new Date().toISOString(),
  }
}

/** Computes a SHA-256 hash of a canonical JSON value. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Projects message records into deterministic sequence, part-type, and content hashes. */
export function canonicalTraceSource(records: readonly MessageRecord[]): Array<{
  seq: number
  kind: MessageRecord['kind']
  partTypes: string[]
  hash: string
}> {
  return records.map((record) => ({
    seq: record.seq,
    kind: record.kind,
    partTypes: record.parts.map((part) => part.type),
    hash: canonicalHash(record.parts),
  }))
}

/** Extracts and joins text parts from a MessageRecord. */
export function messageText(record: MessageRecord): string {
  return record.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(record.kind === 'conversation_transcript' ? '' : '\n')
}

/** Appends a canonical prompt record with its source kind and content metadata. */
export function appendPromptMessage(
  state: CanonicalHistoryState,
  input: {
    kind: Exclude<CanonicalPromptKind, 'conversation_transcript'>
    content: string
    source: string
    trusted: boolean
    editable: boolean
    resource?: PromptResourceSummary
    hash?: string
    turnId?: MessageId
    interjectionId?: string
  },
): MessageRecord {
  const content = input.content.trim()
  if (!content) {
    throw new TypeError(`Canonical ${input.kind} content must not be empty`)
  }
  const hash = input.hash ?? createHash('sha256').update(content).digest('hex')
  const record = {
    ...nextIdentity(state),
    visibility:
      input.kind === 'orchestrator' || input.kind === 'interjection'
        ? ('visible' as const)
        : ('hidden' as const),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: input.kind,
    parts: [{ type: 'text' as const, text: content }],
    metadata: {
      schemaVersion: 1 as const,
      layer: {
        source: input.source,
        trusted: input.trusted,
        editable: input.editable,
        hash,
      },
      ...(input.resource
        ? {
            prompt: {
              resourceId: input.resource.id,
              version: input.resource.version,
              hash: input.resource.sha256,
            },
          }
        : {}),
      ...(input.interjectionId ? { interjectionId: input.interjectionId } : {}),
    },
  } as MessageRecord
  state.history.push(record)
  return record
}

/** Appends a user-input record and optional client/idempotency metadata to history. */
export function appendUserInput(
  state: CanonicalHistoryState,
  input: {
    content: string
    clientRequestId?: string
    replayedFromMessageId?: MessageId
    derivedFromMessageId?: MessageId
    requestHash?: string
    submission?: 'message' | { controlCommand: string }
    inHistory?: boolean
    messageId?: MessageId
    turnId?: MessageId
    attachments?: ContextAttachmentChip[]
  },
): Extract<MessageRecord, { kind: 'user_input' }> {
  if (!input.content.trim()) {
    throw new TypeError('Canonical user input must not be empty')
  }
  const identityCount = [
    input.clientRequestId,
    input.replayedFromMessageId,
    input.derivedFromMessageId,
  ].filter((value) => value !== undefined).length
  if (identityCount !== 1) {
    throw new TypeError(
      'User input must have exactly one client request, replay source, or derivation source',
    )
  }
  const identity = nextIdentity(state)
  const messageId = input.messageId ?? identity.id
  const record = {
    ...identity,
    id: messageId,
    visibility:
      input.submission && typeof input.submission === 'object'
        ? ('hidden' as const)
        : input.replayedFromMessageId || input.derivedFromMessageId
          ? ('hidden' as const)
          : ('visible' as const),
    turnId: input.turnId ?? messageId,
    inHistory: input.inHistory ?? identity.inHistory,
    kind: 'user_input' as const,
    ...(input.clientRequestId
      ? { clientRequestId: input.clientRequestId }
      : {}),
    parts: [{ type: 'text' as const, text: input.content }],
    metadata: input.replayedFromMessageId
      ? {
          schemaVersion: 1 as const,
          replayedFromMessageId: input.replayedFromMessageId,
        }
      : input.derivedFromMessageId
        ? {
            schemaVersion: 1 as const,
            derivedFromMessageId: input.derivedFromMessageId,
            derivation: 'control_command_payload' as const,
          }
        : {
            schemaVersion: 1 as const,
            ...(input.requestHash ? { requestHash: input.requestHash } : {}),
            ...(input.attachments
              ? { attachments: structuredClone(input.attachments) }
              : {}),
            submission:
              typeof input.submission === 'object'
                ? {
                    type: 'control_command' as const,
                    command: input.submission.controlCommand,
                  }
                : { type: 'message' as const },
          },
  } as Extract<MessageRecord, { kind: 'user_input' }>
  state.history.push(record)
  return record
}

/** Appends a slash/control command with its client request identity. */
export function appendControlCommand(
  state: CanonicalHistoryState,
  input: {
    content: string
    clientRequestId: string
    requestHash: string
    command: string
  },
): Extract<MessageRecord, { kind: 'user_input' }> {
  return appendUserInput(state, {
    content: input.content,
    clientRequestId: input.clientRequestId,
    requestHash: input.requestHash,
    submission: { controlCommand: input.command },
    inHistory: false,
  })
}

/** Appends an assistant turn with text, reasoning, tool calls, and usage metadata. */
export function appendAssistantTurn(
  state: CanonicalHistoryState,
  input: {
    text: string
    toolCalls: readonly {
      id: CallId
      toolId: string
      args: JsonValue
    }[]
    reasoning?: string
    finishReason?: string
    route: ModelRouteSnapshot
    usage?: CanonicalUsageInput
    continuation?: Extract<
      MessageRecord,
      { kind: 'assistant_turn' }
    >['providerContinuation']
  },
): Extract<MessageRecord, { kind: 'assistant_turn' }> {
  const parts: Array<
    | { type: 'text'; text: string }
    | {
        type: 'tool_call'
        callId: CallId
        name: string
        arguments: JsonValue
      }
  > = []
  if (input.text) parts.push({ type: 'text', text: input.text })
  for (const call of input.toolCalls) {
    parts.push({
      type: 'tool_call',
      callId: call.id,
      name: call.toolId,
      arguments: structuredClone(call.args),
    })
  }
  return appendCompletedAssistantTurn(state, {
    parts,
    reasoning: input.reasoning,
    finishReason: input.finishReason,
    route: input.route,
    continuation: input.continuation,
    usage: input.usage,
  })
}

/** Validates an assistant turn against current sequence, tool-call, and history invariants. */
export function assertAssistantTurnCandidate(
  state: CanonicalHistoryState,
  input: AssistantTurnCandidateInput,
): void {
  const record = assistantTurnCandidate(state, input)
  if (!validateMessageRecord(record)) {
    throw new TypeError(
      `Canonical assistant completion is invalid: ${formatSchemaErrors(
        validateMessageRecord.errors,
      )}`,
    )
  }
  assertMessageRecordSemantics(record)
  assertBoundedJsonValue(record)

  const existingCallIds = new Set<string>()
  for (const existing of state.history) {
    if (!existing.inHistory || existing.kind !== 'assistant_turn') continue
    for (const part of existing.parts) {
      if (part.type === 'tool_call') existingCallIds.add(part.callId)
    }
  }
  for (const part of record.parts) {
    if (part.type !== 'tool_call') continue
    if (existingCallIds.has(part.callId)) {
      throw new TypeError(
        `Duplicate tool call id in active history: ${part.callId}`,
      )
    }
    existingCallIds.add(part.callId)
  }
}

/** Validates and appends a completed assistant turn to canonical history. */
export function appendCompletedAssistantTurn(
  state: CanonicalHistoryState,
  input: AssistantTurnCandidateInput,
): Extract<MessageRecord, { kind: 'assistant_turn' }> {
  assertAssistantTurnCandidate(state, input)
  const record = assistantTurnCandidate(state, input, nextIdentity(state))
  state.history.push(record)
  return record
}

function assistantTurnCandidate(
  state: CanonicalHistoryState,
  input: AssistantTurnCandidateInput,
  identity: ReturnType<typeof nextIdentity> = {
    schemaVersion: 1,
    id: 'message:assistant-validation-candidate' as MessageId,
    sessionId: state.sessionId,
    seq: state.nextMessageSeq,
    visibility: 'visible',
    inHistory: true,
    createdAt: new Date().toISOString(),
  },
): Extract<MessageRecord, { kind: 'assistant_turn' }> {
  const record = {
    ...identity,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: 'assistant_turn' as const,
    parts: structuredClone(input.parts),
    modelRoute: structuredClone(input.route),
    ...(input.reasoning ? { normalizedReasoningText: input.reasoning } : {}),
    ...(input.continuation
      ? { providerContinuation: structuredClone(input.continuation) }
      : {}),
    ...(input.finishReason || input.usage
      ? {
          metadata: {
            schemaVersion: 1 as const,
            ...(input.finishReason ? { finishReason: input.finishReason } : {}),
            ...(input.usage ? { usage: structuredClone(input.usage) } : {}),
          },
        }
      : {}),
  } as Extract<MessageRecord, { kind: 'assistant_turn' }>
  return record
}

/** Appends a tool result linked to its provider call ID and optional file-change metadata. */
export function appendToolResult(
  state: CanonicalHistoryState,
  input: {
    callId: CallId
    content: ToolResultContent
    isError: boolean
    name: string
    reason?: string
    status: 'completed' | 'denied' | 'failed' | 'cancelled' | 'timed_out'
    truncated: boolean
    durationMs?: number
    turnId?: MessageId
  },
): Extract<MessageRecord, { kind: 'tool_result' }> {
  const record = {
    ...nextIdentity(state),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: 'tool_result' as const,
    parts: [
      {
        type: 'tool_result' as const,
        callId: input.callId,
        content: structuredClone(input.content),
        isError: input.isError,
      },
    ],
    metadata: {
      schemaVersion: 1 as const,
      tool: {
        name: input.name,
        ...(input.reason ? { reason: input.reason } : {}),
        resultProjection: 'model-content.v1' as const,
        status: input.status,
        truncated: input.truncated,
        ...(input.durationMs === undefined
          ? {}
          : { durationMs: Math.max(0, Math.round(input.durationMs)) }),
      },
    },
  } as Extract<MessageRecord, { kind: 'tool_result' }>
  state.history.push(record)
  return record
}

/** Appends a compaction summary and marks the replaced history boundary. */
export function appendCompactSummary(
  state: CanonicalHistoryState,
  input: {
    content: string
    replacesThroughSeq: number
    sourceHash: string
    resource?: PromptResourceSummary
    turnId?: MessageId
  },
): Extract<MessageRecord, { kind: 'compact_summary' }> {
  const record = {
    ...nextIdentity(state),
    visibility: 'hidden' as const,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: 'compact_summary' as const,
    parts: [{ type: 'text' as const, text: input.content }],
    metadata: {
      schemaVersion: 1 as const,
      compact: {
        replacesThroughSeq: input.replacesThroughSeq,
        sourceHash: input.sourceHash,
      },
      ...(input.resource
        ? {
            prompt: {
              resourceId: input.resource.id,
              version: input.resource.version,
              hash: input.resource.sha256,
            },
          }
        : {}),
    },
  } as Extract<MessageRecord, { kind: 'compact_summary' }>
  state.history.push(record)
  return record
}

/** Appends an opaque Provider-native compact checkpoint. */
export function appendProviderCompactSummary(
  state: CanonicalHistoryState,
  input: {
    payload: ProviderCompactEnvelope
    route: ModelRouteSnapshot
    replacesThroughSeq: number
    sourceHash: string
    usage?: CanonicalUsageInput
    resource?: PromptResourceSummary
    turnId?: MessageId
  },
): Extract<MessageRecord, { kind: 'compact_summary' }> {
  if (input.payload.providerType !== input.route.providerType) {
    throw new TypeError('Provider compact payload does not match its route')
  }
  const record = {
    ...nextIdentity(state),
    visibility: 'hidden' as const,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: 'compact_summary' as const,
    parts: [
      {
        type: 'provider_compact' as const,
        payload: structuredClone(input.payload),
      },
    ],
    modelRoute: structuredClone(input.route),
    metadata: {
      schemaVersion: 1 as const,
      compact: {
        replacesThroughSeq: input.replacesThroughSeq,
        sourceHash: input.sourceHash,
      },
      ...(input.usage ? { usage: structuredClone(input.usage) } : {}),
      ...(input.resource
        ? {
            prompt: {
              resourceId: input.resource.id,
              version: input.resource.version,
              hash: input.resource.sha256,
            },
          }
        : {}),
    },
  } as Extract<MessageRecord, { kind: 'compact_summary' }>
  if (!validateMessageRecord(record)) {
    throw new TypeError(
      `Canonical Provider compact is invalid: ${formatSchemaErrors(
        validateMessageRecord.errors,
      )}`,
    )
  }
  assertMessageRecordSemantics(record)
  state.history.push(record)
  return record
}

/** Appends a hidden Markdown transcript used as a portable model-history anchor. */
export function appendConversationTranscript(
  state: CanonicalHistoryState,
  input: {
    content: string
    route: ModelRouteSnapshot
    sourceThroughSeq: number
    sourceHash: string
    contentHash: string
  },
): Extract<MessageRecord, { kind: 'conversation_transcript' }> {
  if (!input.content) {
    throw new TypeError('Conversation transcript content must not be empty')
  }
  const parts: Array<{ type: 'text'; text: string }> = []
  for (
    let offset = 0;
    offset < input.content.length;
    offset += MAX_MESSAGE_TEXT_LENGTH
  ) {
    parts.push({
      type: 'text',
      text: input.content.slice(offset, offset + MAX_MESSAGE_TEXT_LENGTH),
    })
  }
  if (parts.length > MAX_MESSAGE_PARTS) {
    throw new RangeError(
      'Conversation transcript exceeds canonical part limits',
    )
  }
  const record = {
    ...nextIdentity(state),
    visibility: 'hidden' as const,
    kind: 'conversation_transcript' as const,
    parts,
    modelRoute: structuredClone(input.route),
    metadata: {
      schemaVersion: 1 as const,
      layer: {
        source: 'history.conversation-transcript',
        trusted: true,
        editable: false,
        hash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
      },
      transcript: {
        format: 'zch-conversation-markdown' as const,
        version: 1 as const,
        sourceThroughSeq: input.sourceThroughSeq,
        sourceHash: input.sourceHash,
        contentHash: input.contentHash,
      },
    },
  } as Extract<MessageRecord, { kind: 'conversation_transcript' }>
  if (!validateMessageRecord(record)) {
    throw new TypeError(
      `Canonical conversation transcript is invalid: ${formatSchemaErrors(
        validateMessageRecord.errors,
      )}`,
    )
  }
  assertMessageRecordSemantics(record)
  state.history.push(record)
  return record
}

/** Finds the most recent content hash for a prompt kind. */
export function latestPromptHash(
  state: CanonicalHistoryState,
  kind: CanonicalPromptKind,
): string | undefined {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const record = state.history[index]!
    if (!record.inHistory || record.kind !== kind) continue
    return record.metadata?.layer.hash
  }
  return undefined
}

/** Marks active-history records inactive and returns the records it changed. */
export function deactivateActiveHistory(
  state: CanonicalHistoryState,
): MessageRecord[] {
  const active = state.history.filter((record) => record.inHistory)
  for (const record of active) record.inHistory = false
  return active
}

/** Compiles persisted message records into provider-ready canonical history. */
export class MessageHistoryCompiler {
  /** Filters active non-superseded records and validates their sequence and turn structure. */
  compile(records: readonly MessageRecord[]): CompiledCanonicalHistory {
    const active = records
      .filter(
        (record) => record.inHistory && record.visibility !== 'superseded',
      )
      .sort((left, right) => left.seq - right.seq)
    if (active.length === 0) {
      throw new TypeError('Canonical history must not be empty')
    }
    const sessionId = active[0]!.sessionId
    const ids = new Set<string>()
    const calls = new Set<string>()
    let previousSeq = 0
    let pending: string[] | undefined
    let compactBoundary: number | undefined

    for (const record of active) {
      if (!validateMessageRecord(record)) {
        throw new TypeError(
          `Canonical message is invalid: ${formatSchemaErrors(
            validateMessageRecord.errors,
          )}`,
        )
      }
      assertMessageRecordSemantics(record)
      if (
        record.kind === 'tool_result' &&
        record.metadata?.tool.resultProjection !== 'model-content.v1'
      ) {
        throw new LegacyToolResultError()
      }
      if (record.sessionId !== sessionId) {
        throw new TypeError('Canonical history contains multiple sessions')
      }
      if (record.seq <= previousSeq || ids.has(record.id)) {
        throw new TypeError('Canonical history identity/order is invalid')
      }
      previousSeq = record.seq
      ids.add(record.id)
      if (compactBoundary !== undefined && record.seq <= compactBoundary) {
        throw new TypeError('Active history crosses its compact boundary')
      }
      if (record.kind === 'compact_summary') {
        if (compactBoundary !== undefined) {
          throw new TypeError(
            'Active history contains multiple compact summaries',
          )
        }
        const boundary = record.metadata.compact.replacesThroughSeq
        compactBoundary = boundary
        if (
          boundary >= record.seq ||
          active.some((candidate) => candidate.seq <= boundary)
        ) {
          throw new TypeError('Compact summary boundary is invalid')
        }
      }

      if (pending) {
        if (record.kind !== 'tool_result') {
          throw new TypeError('Assistant tool calls require terminal results')
        }
        const callId = record.parts[0].callId
        const expected = pending.shift()
        if (callId !== expected) {
          throw new TypeError(
            `Tool result is out of order; expected ${expected}, received ${callId}`,
          )
        }
        if (pending.length === 0) pending = undefined
        continue
      }

      if (record.kind === 'tool_result') {
        throw new TypeError(
          `Tool result has no preceding assistant call: ${record.parts[0].callId}`,
        )
      }
      if (record.kind !== 'assistant_turn') continue
      const turnCalls = record.parts.filter(
        (part): part is ToolCallPart => part.type === 'tool_call',
      )
      if (turnCalls.length === 0) continue
      pending = []
      for (const call of turnCalls) {
        if (calls.has(call.callId)) {
          throw new TypeError(`Duplicate tool call id: ${call.callId}`)
        }
        calls.add(call.callId)
        pending.push(call.callId)
      }
    }
    if (pending) {
      throw new TypeError('Canonical history ends inside a tool batch')
    }

    return {
      sessionId,
      messages: active,
      sourceHash: canonicalHash(
        active.map((record) => ({
          id: record.id,
          seq: record.seq,
          kind: record.kind,
          parts: record.parts,
        })),
      ),
    }
  }
}
