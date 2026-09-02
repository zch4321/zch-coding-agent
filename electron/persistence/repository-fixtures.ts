import type { CallId, MessageId, ProjectId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ProjectRecord } from '../../shared/project'
import type { SessionRecord } from '../../shared/session'
import type { PersistenceTransaction } from './database-service'
import { encodeSessionRow } from './session-codec'

export const FIXTURE_HASH = 'a'.repeat(64)
export const FIXTURE_TIMESTAMP = '2026-07-22T00:00:00.000Z'

/** Inserts a Session through the pre-0009 column list into a legacy-schema database. */
export function insertLegacySession(
  transaction: PersistenceTransaction,
  record: SessionRecord,
): void {
  const row = encodeSessionRow(record)
  transaction
    .prepare(
      `INSERT INTO sessions (
         schema_version, id, project_id, title, lifecycle, permission_mode,
         provider_id, model, reasoning, goal_json, plan_json,
         parent_session_id, forked_from_seq, revision, last_seq, created_at,
         updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.schema_version,
      row.id,
      row.project_id,
      row.title,
      row.lifecycle,
      row.permission_mode,
      row.provider_id,
      row.model,
      row.reasoning,
      row.goal_json,
      row.plan_json,
      row.parent_session_id,
      row.forked_from_seq,
      row.revision,
      row.last_seq,
      row.created_at,
      row.updated_at,
      row.archived_at,
    )
}

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
    titleSource: 'user',
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
    visibility: 'visible' as const,
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
        schemaVersion: 2,
        providerType: 'deepseek.chat-completions',
        format: 'reasoning-v1',
        data: { state: ['one', 'two'] },
      },
      modelRoute: {
        schemaVersion: 2,
        purpose: 'main',
        providerType: 'deepseek.chat-completions',
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
        schemaVersion: 2,
        purpose: 'main',
        providerType: 'deepseek.chat-completions',
        providerId: 'deepseek',
        model: 'deepseek-chat',
        reasoning: 'off',
        endpoint: 'https://api.deepseek.com/chat/completions',
        providerConfigRevision: 1,
      },
    },
  ]
}
