import { describe, expect, it, vi } from 'vitest'
import type { MessageId, ProjectId, SessionId } from '../../shared/ids'
import { MessageRepository } from '../persistence/message-repository'
import { ProjectRepository } from '../persistence/project-repository'
import { SessionRepository } from '../persistence/session-repository'
import {
  messageFixtures,
  projectFixture,
  sessionFixture,
} from '../persistence/repository-fixtures'
import { createTestDatabase } from '../persistence/test-database'
import { ApplicationStateCoordinator } from './application-state-coordinator'
import { SessionService } from './session-service'

describe('Session search matching and pagination', () => {
  it('pages past false hits before applying limit and matches decoded Unicode text', async () => {
    const fixture = await createTestDatabase()
    const sessions = new SessionRepository()
    const messages = new MessageRepository()
    const service = new SessionService({
      coordinator: new ApplicationStateCoordinator({
        database: fixture.database,
      }),
      sessions,
      messages,
    })
    try {
      const target = sessionFixture({ id: 'session:000' as SessionId })
      await fixture.database.withTransaction((tx) => {
        new ProjectRepository().insert(tx, projectFixture())
        sessions.insert(tx, target)
        const user = messageFixtures(target.id)[0]!
        messages.insert(tx, {
          ...user,
          parts: [{ type: 'text', text: 'needle ÄPFEL C:\\path\nnext' }],
        } as typeof user)
        for (let index = 1; index <= 101; index++) {
          const session = sessionFixture({
            id: `session:${String(index).padStart(3, '0')}` as SessionId,
          })
          sessions.insert(tx, session)
          const assistant = messageFixtures(session.id)[1]!
          if (assistant.kind !== 'assistant_turn')
            throw Error('invalid fixture')
          messages.insert(tx, {
            ...assistant,
            id: `tool:${index}` as MessageId,
            parts: [
              {
                type: 'tool_call',
                callId: `call:${index}` as never,
                name: 'read_file',
                arguments: { path: 'needle' },
              },
            ],
          })
          if (user.kind !== 'user_input' || !('clientRequestId' in user))
            throw Error('invalid fixture')
          messages.insert(tx, {
            ...user,
            sessionId: session.id,
            id: `control:${index}` as MessageId,
            inHistory: false,
            parts: [{ type: 'text', text: '/compact needle' }],
            metadata: {
              schemaVersion: 1,
              submission: { type: 'control_command', command: 'compact' },
            },
          })
        }
      })
      const pages = vi.spyOn(sessions, 'listPage')
      for (const text of ['needle', 'äpfel', 'C:\\path\nnext']) {
        const hits = await service.searchSessions({ text, limit: 1 })
        expect(hits).toMatchObject([
          {
            session: { id: target.id },
            match: { kind: 'message', messageId: 'message:1' },
          },
        ])
      }
      expect(pages).toHaveBeenCalledTimes(6)
      expect(
        await service.searchSessions({ text: 'tool_call', limit: 1 }),
      ).toEqual([])
      expect(
        await service.searchSessions({
          text: 'needle',
          projectId: 'missing' as ProjectId,
        }),
      ).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })

  it('uses the same recent 2000-message window as in-Session search and excludes archived Sessions', async () => {
    const fixture = await createTestDatabase()
    const sessions = new SessionRepository()
    const messages = new MessageRepository()
    const service = new SessionService({
      coordinator: new ApplicationStateCoordinator({
        database: fixture.database,
      }),
    })
    const session = sessionFixture({ lastSeq: 2001 })
    try {
      await fixture.database.withTransaction((tx) => {
        new ProjectRepository().insert(tx, projectFixture())
        sessions.insert(tx, session)
        sessions.insert(
          tx,
          sessionFixture({
            id: 'archived' as SessionId,
            title: 'old needle',
            lifecycle: 'archived',
            archivedAt: session.updatedAt,
          }),
        )
        const user = messageFixtures(session.id)[0]!
        if (user.kind !== 'user_input' || !('clientRequestId' in user))
          throw Error('invalid fixture')
        for (let seq = 1; seq <= 2001; seq++)
          messages.insert(tx, {
            ...user,
            id: `m:${seq}` as MessageId,
            seq,
            clientRequestId: `request:${seq}`,
            parts: [
              { type: 'text', text: seq === 1 ? 'old needle' : 'recent text' },
            ],
          })
      })
      expect(await service.searchSessions({ text: 'old needle' })).toEqual([])
      expect(
        await service.searchMessages(session.id, { text: 'old needle' }),
      ).toEqual([])
      expect(
        await service.searchSessions({ text: 'recent text', limit: 1 }),
      ).toMatchObject([{ match: { seq: 2001 } }])
    } finally {
      await fixture.dispose()
    }
  })
})
