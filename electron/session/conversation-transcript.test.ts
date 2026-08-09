import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CallId, SessionId } from '../../shared/ids'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendCompactSummary,
  appendControlCommand,
  appendConversationTranscript,
  appendPromptMessage,
  appendToolResult,
  appendUserInput,
  type CanonicalHistoryState,
} from './canonical-history'
import {
  conversationTranscriptContent,
  renderConversationTranscript,
} from './conversation-transcript'

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerType: 'openai.responses',
  providerId: 'openai',
  model: 'gpt-5.6',
  reasoning: 'high',
  endpoint: 'https://api.openai.com/v1/responses',
  providerConfigRevision: 3,
}

function state(): CanonicalHistoryState {
  return {
    sessionId: 'session:transcript-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
}

describe('conversation transcript', () => {
  it('renders only portable conversation semantics in canonical order', () => {
    const history = state()
    appendPromptMessage(history, {
      kind: 'system_instruction',
      content: 'SECRET SYSTEM HARNESS',
      source: 'test:system',
      trusted: true,
      editable: false,
    })
    const user = appendUserInput(history, {
      content: 'Inspect the project. ]]>',
      clientRequestId: 'request:transcript',
      attachments: [
        {
          kind: 'file',
          path: 'src/main.ts',
          source: 'mention',
          totalBytes: 128,
        },
      ],
    })
    appendPromptMessage(history, {
      kind: 'orchestrator',
      content: 'Continue after the tool result.',
      source: 'test:orchestrator',
      trusted: true,
      editable: false,
      turnId: user.id,
    })
    appendAssistantTurn(history, {
      text: 'I will inspect it.',
      reasoning: 'Read the entry point first.',
      route,
      toolCalls: [
        {
          id: 'call:read' as CallId,
          toolId: 'read_file',
          args: { path: 'src/main.ts' },
        },
      ],
      continuation: {
        schemaVersion: 2,
        providerType: 'openai.responses',
        format: 'responses.output-items.v1',
        data: { encrypted_content: 'SECRET ENCRYPTED REASONING' },
      },
    })
    appendToolResult(history, {
      callId: 'call:read' as CallId,
      content: [{ type: 'text', text: 'const fence = ````' }],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    appendPromptMessage(history, {
      kind: 'interjection',
      content: 'Also inspect the tests.',
      source: 'test:interjection',
      trusted: false,
      editable: false,
      turnId: user.id,
    })
    appendAssistantTurn(history, {
      text: 'The entry point is sound.',
      route,
      toolCalls: [],
    })
    appendControlCommand(history, {
      content: '/compact SECRET COMMAND',
      clientRequestId: 'request:compact',
      requestHash: 'a'.repeat(64),
      command: 'compact',
    })
    appendUserInput(history, {
      content: 'SECRET REPLAY',
      replayedFromMessageId: user.id,
    })
    appendCompactSummary(history, {
      content: 'SECRET COMPACT SUMMARY',
      replacesThroughSeq: 1,
      sourceHash: 'b'.repeat(64),
    })
    appendConversationTranscript(history, {
      content: 'SECRET GENERATED TRANSCRIPT',
      route,
      sourceThroughSeq: 1,
      sourceHash: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
    })
    const superseded = appendAssistantTurn(history, {
      text: 'SECRET SUPERSEDED BRANCH',
      route,
      toolCalls: [],
    })
    superseded.visibility = 'superseded'
    superseded.inHistory = false

    const document = renderConversationTranscript(history.history, {
      mode: 'export',
      sessionId: history.sessionId,
      title: 'Transcript fixture',
      exportedAt: '2026-08-08T00:00:00.000Z',
    })

    expect(document.markdown).toContain('## User\n\nInspect the project. ]]>')
    expect(document.markdown).toContain(
      '- Attachment: src/main.ts · file · 128 bytes',
    )
    expect(document.markdown).toContain('## Orchestration')
    expect(document.markdown).toContain('## Assistant reasoning')
    expect(document.markdown).toContain('Read the entry point first.')
    expect(document.markdown).toContain('## Tool call · read_file')
    expect(document.markdown).toContain('## Tool result · read_file')
    expect(document.markdown).toContain('`````text\nconst fence = ````\n`````')
    expect(document.markdown).toContain('## User interjection')
    expect(document.markdown).toContain('The entry point is sound.')
    expect(document.markdown).not.toMatch(
      /SECRET SYSTEM|SECRET ENCRYPTED|SECRET COMMAND|SECRET REPLAY|SECRET COMPACT|SECRET GENERATED|SECRET SUPERSEDED/u,
    )
    expect(document.contentHash).toBe(
      createHash('sha256').update(document.markdown, 'utf8').digest('hex'),
    )
  })

  it('marks provider-transfer truncation and produces CDATA-safe XML', () => {
    const history = state()
    appendUserInput(history, {
      content: 'Keep this ]]> boundary.',
      clientRequestId: 'request:cdata',
    })
    appendAssistantTurn(history, {
      text: '',
      route,
      toolCalls: [
        {
          id: 'call:large' as CallId,
          toolId: 'read_file',
          args: { path: 'large.txt' },
        },
      ],
    })
    appendToolResult(history, {
      callId: 'call:large' as CallId,
      content: [{ type: 'text', text: 'abcdefghij' }],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })

    const document = renderConversationTranscript(history.history, {
      mode: 'provider_transfer',
      sessionId: history.sessionId,
      title: 'CDATA fixture',
      maxToolResultChars: 4,
    })
    const wrapped = conversationTranscriptContent(document)

    expect(document.markdown).toContain('abcd')
    expect(document.markdown).toContain(
      '[tool result truncated for provider transfer: 6 characters omitted]',
    )
    expect(wrapped).toContain(']]]]><![CDATA[>')
    expect(wrapped).toContain(`sha256="${document.contentHash}"`)
  })

  it('exports legacy Tool Results but rejects them from provider transfer', () => {
    const history = state()
    appendUserInput(history, {
      content: 'Read the legacy fixture.',
      clientRequestId: 'request:legacy-transcript',
    })
    appendAssistantTurn(history, {
      text: '',
      route,
      toolCalls: [
        {
          id: 'call:legacy-transcript' as CallId,
          toolId: 'read_file',
          args: { path: 'legacy.txt' },
        },
      ],
    })
    const legacy = appendToolResult(history, {
      callId: 'call:legacy-transcript' as CallId,
      content: [{ type: 'text', text: 'legacy result remains exportable' }],
      isError: false,
      name: 'read_file',
      status: 'completed',
      truncated: false,
    })
    if (!legacy.metadata) throw new Error('Tool metadata fixture is missing')
    delete legacy.metadata.tool.resultProjection

    const exported = renderConversationTranscript(history.history, {
      mode: 'export',
      sessionId: history.sessionId,
      title: 'Legacy export fixture',
      exportedAt: '2026-08-09T00:00:00.000Z',
    })

    expect(exported.markdown).toContain('legacy result remains exportable')
    expect(() =>
      renderConversationTranscript(history.history, {
        mode: 'provider_transfer',
        sessionId: history.sessionId,
        title: 'Legacy transfer fixture',
        maxToolResultChars: 1_024,
      }),
    ).toThrow(/LEGACY_TOOL_RESULT_UNSUPPORTED/u)
  })
})
