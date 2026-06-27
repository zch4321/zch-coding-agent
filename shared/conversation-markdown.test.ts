import { describe, expect, it } from 'vitest'
import type { CallId, RunId } from './ids'
import type { ChatMessage, ConversationRecord } from './workbench'
import {
  CONVERSATION_MARKDOWN_FORMAT,
  CONVERSATION_MARKDOWN_SCHEMA_VERSION,
  ConversationMarkdownError,
  conversationToMarkdown,
  markdownToConversation,
} from './conversation-markdown'

const runId = 'run-1' as RunId
const callId = 'call-1' as CallId

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'user',
    text: 'hello',
    reasoning: '',
    order: 0,
    ...overrides,
  }
}

function baseConversation(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: 'conv-1',
    projectPath: 'F:/workspace/app',
    title: 'Fix the bug',
    model: 'deepseek-v4-pro',
    mode: 'auto',
    messages: [message()],
    tools: [],
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:01:00.000Z',
    ...overrides,
  }
}

describe('conversation markdown round-trip', () => {
  it('exports a front-matter document with a transcript body', () => {
    const conversation = baseConversation()
    const markdown = conversationToMarkdown(conversation)

    expect(markdown.startsWith('---\n')).toBe(true)
    expect(markdown).toContain(`format: "${CONVERSATION_MARKDOWN_FORMAT}"`)
    expect(markdown).toContain(
      `schemaVersion: ${CONVERSATION_MARKDOWN_SCHEMA_VERSION}`,
    )
    expect(markdown).toContain('## user')
    expect(markdown).toContain('hello')
  })

  it('round-trips user, assistant, orchestrator messages with attachments and reasoning', () => {
    const conversation = baseConversation({
      messages: [
        message({
          id: 'm1',
          role: 'user',
          text: 'Review @README.md',
          order: 0,
          attachments: [{ kind: 'file', path: 'README.md', source: 'mention' }],
        }),
        message({
          id: 'm2',
          role: 'assistant',
          text: 'Here is the summary.',
          reasoning: 'I considered the structure first.',
          order: 1,
        }),
        message({
          id: 'm3',
          role: 'orchestrator',
          text: 'Delegated to a sub-task.',
          order: 2,
        }),
      ],
    })

    const markdown = conversationToMarkdown(conversation)
    const imported = markdownToConversation(markdown)

    expect(imported.id).toBe(conversation.id)
    expect(imported.title).toBe(conversation.title)
    expect(imported.mode).toBe(conversation.mode)
    expect(imported.projectPath).toBe(conversation.projectPath)
    expect(imported.tools).toEqual([])
    expect(imported.messages).toHaveLength(3)
    expect(imported.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'orchestrator',
    ])
    expect(imported.messages[0]?.text).toBe('Review @README.md')
    expect(imported.messages[0]?.attachments).toMatchObject([
      { kind: 'file', path: 'README.md' },
    ])
    expect(imported.messages[1]?.text).toBe('Here is the summary.')
    expect(imported.messages[1]?.reasoning).toBe(
      'I considered the structure first.',
    )
    expect(imported.messages[2]?.text).toBe('Delegated to a sub-task.')
    // Imported messages get fresh ids and sequential order, no runId.
    expect(imported.messages[0]?.id).not.toBe('m1')
    expect(imported.messages.map((m) => m.order)).toEqual([0, 1, 2])
    expect(imported.messages.every((m) => m.runId === undefined)).toBe(true)
  })

  it('preserves fork metadata through export and import', () => {
    const conversation = baseConversation({
      parentId: 'parent-1',
      parentTitle: 'Original conversation',
      forkPointMessageId: 'm2',
      forkedAt: '2026-06-20T00:02:00.000Z',
    })

    const imported = markdownToConversation(
      conversationToMarkdown(conversation),
    )

    expect(imported.parentId).toBe('parent-1')
    expect(imported.parentTitle).toBe('Original conversation')
    expect(imported.forkPointMessageId).toBe('m2')
    expect(imported.forkedAt).toBe('2026-06-20T00:02:00.000Z')
  })

  it('escapes colons and quotes in front-matter strings', () => {
    const conversation = baseConversation({
      title: 'He said: "hello" and left',
    })
    const markdown = conversationToMarkdown(conversation)
    const imported = markdownToConversation(markdown)

    expect(imported.title).toBe('He said: "hello" and left')
  })

  it('rejects a document missing front matter', () => {
    expect(() => markdownToConversation('## user\nhello')).toThrow(
      ConversationMarkdownError,
    )
    expect(() => markdownToConversation('## user\nhello')).toThrow(
      expect.objectContaining({ code: 'MISSING_FRONT_MATTER' }),
    )
  })

  it('rejects an unsupported schema version', () => {
    const markdown = conversationToMarkdown(baseConversation()).replace(
      'schemaVersion: 1',
      'schemaVersion: 99',
    )
    expect(() => markdownToConversation(markdown)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }),
    )
  })

  it('rejects a transcript without message blocks', () => {
    const markdown = conversationToMarkdown(
      baseConversation({ messages: [] }),
    ).replace(/## user[\s\S]*$/u, '')
    expect(() => markdownToConversation(markdown)).toThrow(
      expect.objectContaining({ code: 'EMPTY_TRANSCRIPT' }),
    )
  })

  it('rejects an invalid permission mode', () => {
    const markdown = conversationToMarkdown(baseConversation()).replace(
      'mode: "auto"',
      'mode: "dangerous"',
    )
    expect(() => markdownToConversation(markdown)).toThrow(
      ConversationMarkdownError,
    )
  })

  it('does not fabricate tool or usage records on import', () => {
    const conversation = baseConversation({
      tools: [
        {
          callId,
          runId,
          tool: 'create_file',
          args: { path: 'a.txt' },
          reason: '',
          status: 'completed',
          result: { ok: true },
          order: 1,
        },
      ],
      usage: [
        {
          runId,
          callId,
          usage: {
            scope: 'main',
            providerId: 'deepseek',
            providerLabel: 'DeepSeek',
            model: 'deepseek-v4-pro',
            contextWindowTokens: 64000,
            contextWindowSource: 'default',
            raw: null,
          },
          order: 1,
        },
      ],
    })

    const imported = markdownToConversation(
      conversationToMarkdown(conversation),
    )

    expect(imported.tools).toEqual([])
    expect(imported.usage).toBeUndefined()
  })
})
