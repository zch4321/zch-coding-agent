import { createHash } from 'node:crypto'
import type { SessionId } from '../../shared/ids'
import {
  isControlCommandUserInput,
  renderToolResultContent,
  type MessageRecord,
} from '../../shared/message'
import {
  canonicalHash,
  LegacyToolResultError,
  messageText,
} from './canonical-history'

export const CONVERSATION_TRANSCRIPT_FORMAT =
  'zch-conversation-markdown' as const
export const CONVERSATION_TRANSCRIPT_VERSION = 1 as const

export interface ConversationTranscriptRenderOptions {
  mode: 'export' | 'provider_transfer'
  sessionId: SessionId
  title: string
  exportedAt?: string
  maxToolResultChars?: number
}

export interface ConversationTranscriptDocument {
  markdown: string
  body: string
  sourceThroughSeq: number
  sourceHash: string
  contentHash: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function markdownFence(value: string, language = ''): string {
  const longest = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length),
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${value}\n${fence}`
}

function limitedToolResult(value: string, limit: number | undefined): string {
  if (limit === undefined || value.length <= limit) return value
  const omitted = value.length - limit
  return `${value.slice(0, limit)}\n\n[tool result truncated for provider transfer: ${omitted} characters omitted]`
}

function attachmentLines(
  record: Extract<MessageRecord, { kind: 'user_input' }>,
): string[] {
  const metadata = record.metadata
  if (!metadata || !('attachments' in metadata) || !metadata.attachments) {
    return []
  }
  return metadata.attachments.map((attachment) => {
    const fields = [attachment.path, attachment.kind]
    if (attachment.totalBytes !== undefined) {
      fields.push(`${attachment.totalBytes} bytes`)
    }
    if (attachment.truncated) fields.push('truncated')
    return `- Attachment: ${fields.join(' · ')}`
  })
}

function renderRecord(
  record: MessageRecord,
  options: ConversationTranscriptRenderOptions,
): string[] {
  if (record.visibility === 'superseded') return []
  switch (record.kind) {
    case 'user_input': {
      if (isControlCommandUserInput(record)) return []
      if (record.metadata && 'replayedFromMessageId' in record.metadata) {
        return []
      }
      const heading =
        record.metadata && 'derivedFromMessageId' in record.metadata
          ? '## User (derived compact follow-up)'
          : '## User'
      return [
        heading,
        '',
        messageText(record),
        ...attachmentLines(record).flatMap((line, index) =>
          index === 0 ? ['', line] : [line],
        ),
      ]
    }
    case 'interjection':
      return ['## User interjection', '', messageText(record)]
    case 'orchestrator':
      return ['## Orchestration', '', messageText(record)]
    case 'assistant_turn': {
      if (record.visibility !== 'visible') return []
      const lines: string[] = []
      if (record.normalizedReasoningText?.trim()) {
        lines.push(
          '## Assistant reasoning',
          '',
          record.normalizedReasoningText.trim(),
        )
      }
      for (const part of record.parts) {
        if (part.type === 'text') {
          if (lines.length > 0) lines.push('')
          lines.push('## Assistant', '', part.text)
        } else if (part.type === 'tool_call') {
          if (lines.length > 0) lines.push('')
          lines.push(
            `## Tool call · ${part.name}`,
            '',
            `Call ID: ${part.callId}`,
            '',
            markdownFence(JSON.stringify(part.arguments, null, 2), 'json'),
          )
        }
      }
      return lines
    }
    case 'tool_result': {
      const part = record.parts[0]
      const metadata = record.metadata?.tool
      if (
        options.mode === 'provider_transfer' &&
        metadata?.resultProjection !== 'model-content.v1'
      ) {
        throw new LegacyToolResultError()
      }
      const name = metadata?.name ?? 'tool'
      const details = [
        `Call ID: ${part.callId}`,
        `Status: ${metadata?.status ?? (part.isError ? 'failed' : 'completed')}`,
        `Error: ${part.isError ? 'yes' : 'no'}`,
        `Truncated: ${metadata?.truncated ? 'yes' : 'no'}`,
        ...(metadata?.durationMs === undefined
          ? []
          : [`Duration: ${metadata.durationMs} ms`]),
      ]
      const result = limitedToolResult(
        renderToolResultContent(part.content),
        options.mode === 'provider_transfer'
          ? options.maxToolResultChars
          : undefined,
      )
      return [
        `## Tool result · ${name}`,
        '',
        ...details,
        '',
        markdownFence(result, 'text'),
      ]
    }
    case 'compact_summary':
    case 'conversation_transcript':
    case 'system_instruction':
    case 'assistant_preferences':
    case 'selected_context':
    case 'runtime_context':
    case 'agents_context':
      return []
  }
}

/** Renders canonical history as deterministic, portable Markdown. */
export function renderConversationTranscript(
  records: readonly MessageRecord[],
  options: ConversationTranscriptRenderOptions,
): ConversationTranscriptDocument {
  const branch = records
    .filter((record) => record.visibility !== 'superseded')
    .sort((left, right) => left.seq - right.seq)
  const sourceThroughSeq = branch.at(-1)?.seq ?? 0
  if (sourceThroughSeq < 1) {
    throw new TypeError('Conversation transcript requires durable history')
  }
  const sourceHash = canonicalHash(
    branch.map((record) => ({
      seq: record.seq,
      kind: record.kind,
      visibility: record.visibility,
      parts: record.parts,
      ...(record.kind === 'assistant_turn' && record.normalizedReasoningText
        ? { reasoning: record.normalizedReasoningText }
        : {}),
    })),
  )
  const sections = branch
    .map((record) => renderRecord(record, options).join('\n').trim())
    .filter(Boolean)
  const body = (
    sections.length > 0
      ? sections.join('\n\n')
      : 'No portable conversation messages were recorded.'
  ).trim()
  const bodyHash = sha256(body)
  const frontmatter = [
    '---',
    `format: ${CONVERSATION_TRANSCRIPT_FORMAT}`,
    `version: ${CONVERSATION_TRANSCRIPT_VERSION}`,
    `session_id: ${JSON.stringify(options.sessionId)}`,
    `title: ${JSON.stringify(options.title)}`,
    ...(options.exportedAt
      ? [`exported_at: ${JSON.stringify(options.exportedAt)}`]
      : []),
    `source_through_seq: ${sourceThroughSeq}`,
    `source_hash: ${sourceHash}`,
    `body_hash: ${bodyHash}`,
    '---',
  ].join('\n')
  const markdown = `${frontmatter}\n\n${body}\n`
  return {
    markdown,
    body,
    sourceThroughSeq,
    sourceHash,
    contentHash: sha256(markdown),
  }
}

/** Wraps transcript Markdown in a CDATA-safe model-visible harness tag. */
export function conversationTranscriptContent(
  document: ConversationTranscriptDocument,
): string {
  const cdata = document.markdown.replace(/\]\]>/gu, ']]]]><![CDATA[>')
  return `<conversation_transcript format="${CONVERSATION_TRANSCRIPT_FORMAT}" version="${CONVERSATION_TRANSCRIPT_VERSION}" through_seq="${document.sourceThroughSeq}" sha256="${document.contentHash}"><![CDATA[${cdata}]]></conversation_transcript>`
}
