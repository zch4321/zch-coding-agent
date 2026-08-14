import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import { DatabaseService } from './database-service'
import { DATABASE_MIGRATIONS } from './migrations'
import { ProjectRepository } from './project-repository'
import {
  FIXTURE_HASH,
  FIXTURE_TIMESTAMP,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { SessionRepository } from './session-repository'
import { SubagentRepository } from './subagent-repository'
import { createTestDatabase } from './test-database'

describe('0008_swarm_executions migration', () => {
  it('preserves v1 Subagent identity and hidden Session ownership', async () => {
    const legacy = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 7),
    })
    const projects = new ProjectRepository()
    const sessions = new SessionRepository()
    const parent = sessionFixture({ lastSeq: 0 })
    const child = sessionFixture({
      id: 'session:migrated-child' as SessionId,
      title: 'Migrated worker',
      permissionMode: 'readonly',
      lastSeq: 0,
    })
    const executionId = 'subagent:migrated' as AgentExecutionId
    await legacy.database.withTransaction((transaction) => {
      projects.insert(transaction, projectFixture())
      sessions.insert(transaction, parent)
      sessions.insert(transaction, child)
      transaction
        .prepare(
          `INSERT INTO subagent_executions (
             schema_version, id, parent_session_id, parent_run_id,
             parent_call_id, spec_hash, status, route_json, created_at,
             updated_at
           ) VALUES (1, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          executionId,
          parent.id,
          'run:migrated',
          'call:migrated',
          FIXTURE_HASH,
          JSON.stringify({ schemaVersion: 1 }),
          FIXTURE_TIMESTAMP,
          FIXTURE_TIMESTAMP,
        )
      transaction
        .prepare(
          `INSERT INTO subagent_sessions (
             schema_version, session_id, execution_id, parent_session_id,
             created_at
           ) VALUES (1, ?, ?, ?, ?)`,
        )
        .run(child.id, executionId, parent.id, FIXTURE_TIMESTAMP)
    })
    const databasePath = legacy.databasePath
    const directory = legacy.directory
    await legacy.database.close()

    const upgraded = DatabaseService.open({
      databasePath,
      appVersion: 'swarm-migration-test',
    })
    try {
      const subagents = new SubagentRepository()
      const migrated = upgraded.read((reader) =>
        subagents.getOwned(reader, {
          parentSessionId: parent.id,
          executionId,
        }),
      )
      expect(migrated).toMatchObject({
        childSessionId: child.id,
        record: {
          id: executionId,
          kind: 'subagent',
          name: 'Subagent',
          status: 'running',
        },
      })
      expect(migrated?.record.parentExecutionId).toBeUndefined()
      expect(migrated?.record.childOrdinal).toBeUndefined()
      expect(
        upgraded.read((reader) =>
          reader.prepare('PRAGMA foreign_key_check').all(),
        ),
      ).toEqual([])
    } finally {
      await upgraded.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
