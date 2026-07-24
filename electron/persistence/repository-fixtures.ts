import { Buffer } from 'node:buffer'
import type {
  CallId,
  FileChangeId,
  MessageId,
  ProjectId,
  SessionId,
} from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { SessionRecord } from '../../shared/session'
import type { StoredFileChangeRecord } from './file-change-codec'

export const FIXTURE_HASH = 'a'.repeat(64)
export const FIXTURE_TIMESTAMP = '2026-07-22T00:00:00.000Z'

export function projectFixture(
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    schemaVersion: 1,
    id: 'project:fixture' as ProjectId,
    path: 'F:\\workspace\\fixture',
    name: 'fixture',
    revision: 1,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  }
}

export function sessionFixture(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'session:fixture' as SessionId,
    projectId: 'project:fixture' as ProjectId,
    title: 'Fixture session',
    lifecycle: 'active',
    permissionMode: 'confirm',
    modelSelection: {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoning: 'off',
    },
    goal: null,
    plan: null,
    revision: 1,
    lastSeq: 4,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  } as SessionRecord
}

export function messageFixtures(
  sessionId = 'session:fixture' as SessionId,
): MessageRecord[] {
  const identity = (id: string, seq: number) => ({
    schemaVersion: 1 as const,
    id: id as MessageId,
    sessionId,
    seq,
    inHistory: true,
    createdAt: new Date(
      Date.parse(FIXTURE_TIMESTAMP) + seq * 1_000,
    ).toISOString(),
  })
  const callId = 'call:fixture' as CallId
  return [
    {
      ...identity('message:1', 1),
      kind: 'user_input',
      clientRequestId: 'request:fixture',
      parts: [{ type: 'text', text: 'visible search needle' }],
      metadata: {
        schemaVersion: 1,
        submission: { type: 'message' },
      },
    },
    {
      ...identity('message:2', 2),
      kind: 'assistant_turn',
      parts: [
        { type: 'text', text: 'Reading the requested file' },
        {
          type: 'tool_call',
          callId,
          name: 'read_file',
          arguments: { path: 'hidden-search-needle.txt' },
        },
      ],
      normalizedReasoningText: 'Use the file tool.',
      providerContinuation: {
        schemaVersion: 1,
        adapterId: 'deepseek.chat-completions',
        format: 'reasoning-v1',
        data: { state: ['one', 'two'] },
      },
      modelRoute: {
        schemaVersion: 1,
        purpose: 'main',
        adapterId: 'deepseek.chat-completions',
        providerId: 'deepseek',
        model: 'deepseek-chat',
        reasoning: 'off',
        endpoint: 'https://api.deepseek.com/chat/completions',
        providerConfigRevision: 1,
      },
      metadata: {
        schemaVersion: 1,
        usage: { inputTokens: 12, outputTokens: 6 },
      },
    },
    {
      ...identity('message:3', 3),
      kind: 'tool_result',
      parts: [
        {
          type: 'tool_result',
          callId,
          content: [
            { type: 'text', text: 'file contents' },
            { type: 'json', value: { bytes: 13 } },
          ],
          isError: false,
        },
      ],
      metadata: {
        schemaVersion: 1,
        tool: {
          name: 'read_file',
          status: 'completed',
          truncated: false,
        },
      },
    },
    {
      ...identity('message:4', 4),
      kind: 'assistant_turn',
      parts: [{ type: 'text', text: 'Final visible answer' }],
      modelRoute: {
        schemaVersion: 1,
        purpose: 'main',
        adapterId: 'deepseek.chat-completions',
        providerId: 'deepseek',
        model: 'deepseek-chat',
        reasoning: 'off',
        endpoint: 'https://api.deepseek.com/chat/completions',
        providerConfigRevision: 1,
      },
    },
  ]
}

export function fileChangeFixture(
  overrides: Partial<StoredFileChangeRecord> = {},
): StoredFileChangeRecord {
  const beforeContent =
    overrides.beforeContent === undefined ? 'before' : overrides.beforeContent
  const diff = overrides.diff ?? 'diff'
  return {
    schemaVersion: 1,
    id: 'file-change:fixture' as FileChangeId,
    sessionId: 'session:fixture' as SessionId,
    callId: 'call:file-change' as CallId,
    path: 'README.md',
    operation: 'patch',
    diff,
    diffHash: FIXTURE_HASH,
    diffTruncated: false,
    beforeExists: true,
    beforeHash: FIXTURE_HASH,
    beforeContent,
    afterExists: true,
    afterHash: FIXTURE_HASH,
    payloadBytes:
      Buffer.byteLength(beforeContent ?? '', 'utf8') +
      Buffer.byteLength(diff, 'utf8'),
    revision: 1,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  }
}
