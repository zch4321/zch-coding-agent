import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  appendAssistantTurn,
  appendConversationTranscript,
  appendProviderCompactSummary,
  appendUserInput,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { DatabaseService } from './database-service'
import { MessageRepository } from './message-repository'
import { DATABASE_MIGRATIONS } from './migrations'
import { ProjectRepository } from './project-repository'
import { projectFixture, sessionFixture } from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { createTestDatabase } from './test-database'

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerType: 'openai.responses',
  providerId: 'openai',
  model: 'gpt-5.6',
  reasoning: 'high',
  endpoint: 'https://api.openai.com/v1/responses',
  providerConfigRevision: 7,
}

describe('0007_conversation_transcript migration', () => {
  it('preserves v6 messages and accepts transcript and native compact rows', async () => {
    const legacy = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 6),
    })
    const project = projectFixture()
    const session = sessionFixture()
    const history: CanonicalHistoryState = {
      sessionId: session.id,
      history: [],
      nextMessageSeq: 1,
    }
    appendUserInput(history, {
      content: 'Preserve this message.',
      clientRequestId: 'request:migration',
    })
    appendAssistantTurn(history, {
      text: 'Preserved response.',
      toolCalls: [],
      route,
    })

    const projects = new ProjectRepository()
    const sessions = new SessionRepository()
    const messages = new MessageRepository()
    await legacy.database.withTransaction((transaction) => {
      projects.insert(transaction, project)
      sessions.insert(transaction, session)
      messages.insertMany(transaction, history.history)
    })
    const databasePath = legacy.databasePath
    const directory = legacy.directory
    await legacy.database.close()

    const upgraded = DatabaseService.open({
      databasePath,
      appVersion: 'conversation-transcript-migration-test',
    })
    try {
      expect(
        upgraded.read((reader) =>
          reader
            .prepare(
              'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1',
            )
            .get(),
        ),
      ).toEqual({
        version: 8,
        name: '0008_swarm_executions',
      })
      expect(
        upgraded
          .read((reader) => messages.listAll(reader, session.id))
          .map((record) => record.kind),
      ).toEqual(['user_input', 'assistant_turn'])

      appendConversationTranscript(history, {
        content:
          '<conversation_transcript><![CDATA[portable]]></conversation_transcript>',
        route,
        sourceThroughSeq: 2,
        sourceHash: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
      })
      appendProviderCompactSummary(history, {
        payload: {
          schemaVersion: 1,
          providerType: 'openai.responses',
          format: 'responses.compaction-output.v1',
          data: {
            output: [{ type: 'compaction', encrypted_content: 'opaque' }],
          },
        },
        route,
        replacesThroughSeq: 3,
        sourceHash: 'c'.repeat(64),
      })
      await upgraded.withTransaction((transaction) => {
        messages.insert(transaction, history.history[2]!)
        messages.insert(transaction, history.history[3]!)
      })

      expect(
        upgraded
          .read((reader) => messages.listAll(reader, session.id))
          .map((record) => record.kind),
      ).toEqual([
        'user_input',
        'assistant_turn',
        'conversation_transcript',
        'compact_summary',
      ])
    } finally {
      await upgraded.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
