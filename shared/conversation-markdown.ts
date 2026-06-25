/**
 * Conversation ↔ Markdown conversion.
 *
 * Process-neutral (no Node/Electron/Vue deps). Lives in `shared/` so both the
 * renderer (building the export string) and the main process (import
 * validation) share one implementation.
 *
 * Format (versioned front matter + transcript body):
 *
 * ```
 * ---
 * schemaVersion: 1
 * format: zch-conversation
 * conversationId: "ui:..."
 * title: "..."
 * model: "..."
 * mode: auto
 * projectPath: "..."
 * createdAt: "2026-06-20T00:00:00.000Z"
 * updatedAt: "2026-06-20T00:00:00.000Z"
 * parentId: "..."          (optional)
 * parentTitle: "..."       (optional)
 * forkPointMessageId: "..." (optional)
 * forkedAt: "..."          (optional)
 * ---
 *
 * ## user
 * message text
 * <!-- attachments -->
 * - file: README.md
 * - directory: src
 * <!-- /attachments -->
 *
 * ## assistant
 * assistant text
 * <!-- reasoning -->
 * reasoning text
 * <!-- /reasoning -->
 * ```
 *
 * Round-trip contract:
 * - Export serializes the message timeline (user/assistant/orchestrator) plus
 *   reasoning and context attachments. Tool executions and usage records are
 *   intentionally NOT part of the markdown format (see road-map R6: "导入历史
 *   不伪造工具执行或 Provider continuation"). Import therefore never fabricates
 *   `ToolActivity`/`UsageActivity`; it reconstructs only messages with fresh
 *   ids/order and no `runId`.
 * - The dialogue remains viewable and re-importable as a transcript.
 */

import type { ChatMessage, ConversationRecord } from './workbench'
import type { ContextAttachmentChip } from './context'
import type { PermissionMode } from './config'

export const CONVERSATION_MARKDOWN_FORMAT = 'zch-conversation'
export const CONVERSATION_MARKDOWN_SCHEMA_VERSION = 1

type MarkdownRole = 'user' | 'assistant' | 'orchestrator'

const ATTACHMENTS_OPEN = '<!-- attachments -->'
const ATTACHMENTS_CLOSE = '<!-- /attachments -->'
const REASONING_OPEN = '<!-- reasoning -->'
const REASONING_CLOSE = '<!-- /reasoning -->'

const FRONT_MATTER_DELIMITER = '---'

export class ConversationMarkdownError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'MISSING_FRONT_MATTER'
      | 'MALFORMED_FRONT_MATTER'
      | 'UNSUPPORTED_FORMAT'
      | 'EMPTY_TRANSCRIPT',
  ) {
    super(message)
    this.name = 'ConversationMarkdownError'
  }
}

interface ConversationMarkdownMeta {
  schemaVersion: number
  format: string
  conversationId: string
  title: string
  model: string
  mode: PermissionMode
  projectPath: string
  createdAt: string
  updatedAt: string
  parentId?: string
  parentTitle?: string
  forkPointMessageId?: string
  forkedAt?: string
}

const VALID_MODES = new Set<PermissionMode>([
  'readonly',
  'auto',
  'confirm',
  'yolo',
])

/**
 * Serialize a scalar value to a YAML-safe front-matter line value.
 * Strings are always double-quoted (with escaping) to avoid ambiguity around
 * colons, leading spaces, and `#`. Booleans and numbers are emitted bare.
 */
function yamlScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (value === undefined || value === null) return '""'
  const text = String(value)
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : line))
    .join('\n')
}

function renderAttachments(attachments: ContextAttachmentChip[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map(
    (attachment) => `- ${attachment.kind}: ${attachment.path}`,
  )
  return `${ATTACHMENTS_OPEN}\n${lines.join('\n')}\n${ATTACHMENTS_CLOSE}\n`
}

function renderMessage(message: ChatMessage): string {
  const role = message.role
  const parts: string[] = []
  parts.push(`## ${role}`)
  const text = message.text ?? ''
  if (text.length > 0) parts.push(indentLines(text))
  if (message.attachments?.length) {
    parts.push(renderAttachments(message.attachments).trimEnd())
  }
  if (message.reasoning && message.reasoning.trim().length > 0) {
    parts.push(REASONING_OPEN)
    parts.push(indentLines(message.reasoning))
    parts.push(REASONING_CLOSE)
  }
  return parts.join('\n')
}

/**
 * Convert a persisted conversation record into a Markdown document.
 */
export function conversationToMarkdown(
  conversation: ConversationRecord,
): string {
  const meta: ConversationMarkdownMeta = {
    schemaVersion: CONVERSATION_MARKDOWN_SCHEMA_VERSION,
    format: CONVERSATION_MARKDOWN_FORMAT,
    conversationId: conversation.id,
    title: conversation.title,
    model: conversation.model,
    mode: conversation.mode,
    projectPath: conversation.projectPath,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }
  if (conversation.parentId) meta.parentId = conversation.parentId
  if (conversation.parentTitle) meta.parentTitle = conversation.parentTitle
  if (conversation.forkPointMessageId)
    meta.forkPointMessageId = conversation.forkPointMessageId
  if (conversation.forkedAt) meta.forkedAt = conversation.forkedAt

  const frontMatterLines: string[] = [FRONT_MATTER_DELIMITER]
  for (const [key, value] of Object.entries(meta)) {
    frontMatterLines.push(`${key}: ${yamlScalar(value)}`)
  }
  frontMatterLines.push(FRONT_MATTER_DELIMITER)

  const body = conversation.messages.map(renderMessage).join('\n\n')
  return `${frontMatterLines.join('\n')}\n\n${body}\n`
}

/**
 * Unquote a YAML scalar value emitted by {@link yamlScalar}.
 */
function parseYamlScalar(raw: string): string | boolean | number {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.length > 1 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  const numeric = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(numeric)) return numeric
  return trimmed
}

function parseFrontMatter(
  block: string,
): Record<string, string | boolean | number> {
  const result: Record<string, string | boolean | number> = {}
  const lines = block.split('\n')
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new ConversationMarkdownError(
        `Malformed front-matter line: ${line}`,
        'MALFORMED_FRONT_MATTER',
      )
    }
    const key = line.slice(0, separator).trim()
    const value = parseYamlScalar(line.slice(separator + 1))
    if (key) result[key] = value
  }
  return result
}

function requireString(
  meta: Record<string, string | boolean | number>,
  key: string,
): string {
  const value = meta[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConversationMarkdownError(
      `Missing required front-matter field: ${key}`,
      'MALFORMED_FRONT_MATTER',
    )
  }
  return value
}

function optionalString(
  meta: Record<string, string | boolean | number>,
  key: string,
): string | undefined {
  const value = meta[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseAttachments(block: string): ContextAttachmentChip[] {
  const attachments: ContextAttachmentChip[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- ')) continue
    const entry = line.slice(2)
    const sep = entry.indexOf(':')
    if (sep === -1) continue
    const kind = entry.slice(0, sep).trim()
    const path = entry.slice(sep + 1).trim()
    if ((kind === 'file' || kind === 'directory') && path.length > 0) {
      attachments.push({ kind, path, source: 'mention' })
    }
  }
  return attachments
}

interface ParsedMessage {
  role: MarkdownRole
  text: string
  reasoning: string
  attachments: ContextAttachmentChip[]
}

function parseMessageBlock(role: MarkdownRole, body: string): ParsedMessage {
  let working = body
  let reasoning = ''
  let attachments: ContextAttachmentChip[] = []

  const reasoningMatch = working.match(
    new RegExp(
      `${escapeRegex(REASONING_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRegex(REASONING_CLOSE)}`,
    ),
  )
  if (reasoningMatch?.[1] !== undefined) {
    reasoning = reasoningMatch[1]
    working =
      working.slice(0, reasoningMatch.index ?? 0) +
      working.slice((reasoningMatch.index ?? 0) + reasoningMatch[0].length)
  }

  const attachmentMatch = working.match(
    new RegExp(
      `${escapeRegex(ATTACHMENTS_OPEN)}\\s*([\\s\\S]*?)\\s*${escapeRegex(ATTACHMENTS_CLOSE)}`,
    ),
  )
  if (attachmentMatch?.[1] !== undefined) {
    attachments = parseAttachments(attachmentMatch[1])
    working =
      working.slice(0, attachmentMatch.index ?? 0) +
      working.slice((attachmentMatch.index ?? 0) + attachmentMatch[0].length)
  }

  return {
    role,
    text: working.replace(/\n+$/u, '').replace(/^\n+/u, ''),
    reasoning,
    attachments,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseTranscript(body: string): ParsedMessage[] {
  const lines = body.split('\n')
  const headingPattern = /^## (user|assistant|orchestrator)\s*$/u
  const blocks: Array<{ role: MarkdownRole; lines: string[] }> = []
  let current: { role: MarkdownRole; lines: string[] } | null = null

  for (const line of lines) {
    const match = line.match(headingPattern)
    if (match) {
      const role = match[1] as MarkdownRole
      current = { role, lines: [] }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }

  if (blocks.length === 0) {
    throw new ConversationMarkdownError(
      'Markdown transcript contains no message blocks',
      'EMPTY_TRANSCRIPT',
    )
  }

  return blocks.map((block) =>
    parseMessageBlock(block.role, block.lines.join('\n')),
  )
}

/**
 * Parse a Markdown document back into a conversation-shaped record (without an
 * id/createdAt for the new conversation — the caller assigns those). Tool and
 * usage arrays are intentionally empty; messages get fresh ids and sequential
 * order with no runId.
 */
export function markdownToConversation(markdown: string): Omit<
  ConversationRecord,
  'id' | 'createdAt' | 'updatedAt'
> & {
  id: string
  createdAt: string
  updatedAt: string
} {
  const content = markdown.replace(/^\uFEFF/u, '')
  const lines = content.split('\n')

  if (lines[0]?.trim() !== FRONT_MATTER_DELIMITER) {
    throw new ConversationMarkdownError(
      'Markdown document is missing a front-matter block',
      'MISSING_FRONT_MATTER',
    )
  }

  let closeIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONT_MATTER_DELIMITER) {
      closeIndex = index
      break
    }
  }

  if (closeIndex === -1) {
    throw new ConversationMarkdownError(
      'Front-matter block is not closed',
      'MALFORMED_FRONT_MATTER',
    )
  }

  const meta = parseFrontMatter(lines.slice(1, closeIndex).join('\n'))

  const schemaVersion = meta.schemaVersion
  if (
    typeof schemaVersion !== 'number' ||
    schemaVersion !== CONVERSATION_MARKDOWN_SCHEMA_VERSION
  ) {
    throw new ConversationMarkdownError(
      `Unsupported markdown schema version: ${String(schemaVersion)}`,
      'UNSUPPORTED_FORMAT',
    )
  }
  if (meta.format !== CONVERSATION_MARKDOWN_FORMAT) {
    throw new ConversationMarkdownError(
      `Unsupported markdown format: ${String(meta.format)}`,
      'UNSUPPORTED_FORMAT',
    )
  }

  const mode = meta.mode
  if (typeof mode !== 'string' || !VALID_MODES.has(mode as PermissionMode)) {
    throw new ConversationMarkdownError(
      `Invalid permission mode in front matter: ${String(mode)}`,
      'MALFORMED_FRONT_MATTER',
    )
  }

  const body = lines.slice(closeIndex + 1).join('\n')
  const parsedMessages = parseTranscript(body)

  const conversationId = requireString(meta, 'conversationId')

  const messages: ChatMessage[] = parsedMessages.map((message, index) => {
    const rebuilt: ChatMessage = {
      id: `imported:${conversationId}:${index}`,
      role: message.role,
      text: message.text,
      reasoning: message.reasoning,
      order: index,
    }
    if (message.attachments.length > 0) {
      rebuilt.attachments = message.attachments
    }
    return rebuilt
  })

  const record: ConversationRecord = {
    id: conversationId,
    projectPath: requireString(meta, 'projectPath'),
    title: requireString(meta, 'title'),
    model: requireString(meta, 'model'),
    mode: mode as PermissionMode,
    messages,
    tools: [],
    createdAt: requireString(meta, 'createdAt'),
    updatedAt: requireString(meta, 'updatedAt'),
  }

  const parentId = optionalString(meta, 'parentId')
  if (parentId) record.parentId = parentId
  const parentTitle = optionalString(meta, 'parentTitle')
  if (parentTitle) record.parentTitle = parentTitle
  const forkPointMessageId = optionalString(meta, 'forkPointMessageId')
  if (forkPointMessageId) record.forkPointMessageId = forkPointMessageId
  const forkedAt = optionalString(meta, 'forkedAt')
  if (forkedAt) record.forkedAt = forkedAt

  return record
}
