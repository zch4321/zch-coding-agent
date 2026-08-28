import { describe, expect, it } from 'vitest'
import type { ProjectId, SessionId } from '../../shared/ids'
import { REASONING_EFFORTS } from '../../shared/config'
import { ProjectRepository } from './project-repository'
import { SessionRepository } from './session-repository'
import {
  insertLegacySession,
  projectFixture,
  sessionFixture,
} from './repository-fixtures'
import { createTestDatabase } from './test-database'
import { DATABASE_MIGRATIONS } from './migrations'

const projects = new ProjectRepository()
const sessions = new SessionRepository()

describe('0006_reasoning_levels migration', () => {
  it('persists every reasoning effort level through SessionRepository', async () => {
    const testDatabase = await createTestDatabase()
    try {
      await testDatabase.database.withTransaction((transaction) => {
        projects.insert(transaction, projectFixture())
        for (const reasoning of REASONING_EFFORTS) {
          sessions.insert(
            transaction,
            sessionFixture({
              id: `session:${reasoning}` as SessionId,
              modelSelection: {
                providerId: 'deepseek',
                model: 'deepseek-chat',
                reasoning,
              },
            }),
          )
        }
      })

      for (const reasoning of REASONING_EFFORTS) {
        const stored = testDatabase.database.read((reader) =>
          sessions.get(reader, `session:${reasoning}` as SessionId),
        )
        expect(stored?.modelSelection.reasoning).toBe(reasoning)
      }

      await testDatabase.database.withTransaction((transaction) => {
        const low = sessions.get(transaction, 'session:low' as SessionId)
        expect(
          sessions.update(
            transaction,
            {
              ...low!,
              modelSelection: {
                ...low!.modelSelection,
                reasoning: 'xhigh',
              },
              revision: 2,
            },
            1,
          ),
        ).toBe(true)
      })
      const updated = testDatabase.database.read((reader) =>
        sessions.get(reader, 'session:low' as SessionId),
      )
      expect(updated?.modelSelection.reasoning).toBe('xhigh')

      // The codec validates records before SQL, so probe the SQLite CHECK
      // constraint directly with raw SQL bypassing the repository codec.
      await expect(
        testDatabase.database.withTransaction((transaction) => {
          transaction
            .prepare(
              `INSERT INTO sessions (
                 schema_version, id, project_id, title, lifecycle,
                 permission_mode, provider_id, model, reasoning, goal_json,
                 plan_json, parent_session_id, forked_from_seq, revision,
                 last_seq, created_at, updated_at, archived_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              1,
              'session:invalid',
              'project:fixture',
              'Invalid',
              'active',
              'confirm',
              'deepseek',
              'deepseek-chat',
              'ultra',
              null,
              null,
              null,
              null,
              1,
              0,
              '2026-07-22T00:00:00.000Z',
              '2026-07-22T00:00:00.000Z',
              null,
            )
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: 'DATABASE_CONSTRAINT' }),
      )
    } finally {
      await testDatabase.dispose()
    }
  })

  it('upgrades a v5 database preserving rows, triggers, and indexes', async () => {
    const v5 = await createTestDatabase({
      migrations: DATABASE_MIGRATIONS.slice(0, 5),
    })
    const project = projectFixture()
    const parent = sessionFixture({
      modelSelection: {
        providerId: 'deepseek',
        model: 'deepseek-chat',
        reasoning: 'high',
      },
    })
    const child = sessionFixture({
      id: 'session:child' as SessionId,
      title: 'Child',
      parent: { sessionId: parent.id, forkedFromSeq: 0 },
    })
    await v5.database.withTransaction((transaction) => {
      projects.insert(transaction, project)
      insertLegacySession(transaction, parent)
      insertLegacySession(transaction, child)
    })
    const databasePath = v5.databasePath
    const directory = v5.directory
    await v5.database.close()

    const { DatabaseService } = await import('./database-service')
    const upgraded = DatabaseService.open({ databasePath, appVersion: 'test' })
    try {
      const migrationRows = upgraded.read((reader) =>
        reader
          .prepare(
            'SELECT version, name FROM schema_migrations ORDER BY version',
          )
          .all(),
      )
      expect(migrationRows.at(-1)).toEqual({
        version: 10,
        name: '0010_active_subagent_capacity',
      })

      const storedParent = upgraded.read((reader) =>
        sessions.get(reader, parent.id),
      )
      const storedChild = upgraded.read((reader) =>
        sessions.get(reader, child.id),
      )
      expect(storedParent?.modelSelection.reasoning).toBe('high')
      expect(storedChild?.parent).toEqual(child.parent)

      const objects = upgraded.read((reader) =>
        reader
          .prepare(
            `SELECT type, name FROM sqlite_master
             WHERE tbl_name = 'sessions' AND type IN ('trigger', 'index')
               AND name NOT LIKE 'sqlite_autoindex%'
             ORDER BY name`,
          )
          .all(),
      )
      expect(objects).toEqual([
        { type: 'trigger', name: 'sessions_clear_parent_before_delete' },
        { type: 'trigger', name: 'sessions_delete_subagent_children' },
        { type: 'index', name: 'sessions_lifecycle_updated_idx' },
        { type: 'index', name: 'sessions_parent_idx' },
        { type: 'index', name: 'sessions_project_updated_idx' },
      ])

      await upgraded.withTransaction((transaction) => {
        sessions.insert(
          transaction,
          sessionFixture({
            id: 'session:low' as SessionId,
            projectId: project.id as ProjectId,
            modelSelection: {
              providerId: 'deepseek',
              model: 'deepseek-chat',
              reasoning: 'low',
            },
          }),
        )
      })
      const storedLow = upgraded.read((reader) =>
        sessions.get(reader, 'session:low' as SessionId),
      )
      expect(storedLow?.modelSelection.reasoning).toBe('low')

      await upgraded.withTransaction((transaction) => {
        transaction.prepare('DELETE FROM sessions WHERE id = ?').run(parent.id)
      })
      const orphan = upgraded.read((reader) => sessions.get(reader, child.id))
      expect(orphan?.parent).toBeUndefined()
    } finally {
      await upgraded.close()
      const { rm } = await import('node:fs/promises')
      await rm(directory, { force: true, recursive: true })
    }
  })
})
