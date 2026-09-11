import type { ProjectId } from '../../shared/ids'
import type { SessionListCursor } from '../../shared/session'
import type { SessionSearchHit } from '../../shared/domain-state-api'
import type { PersistenceReader } from '../persistence/database-service'
import type { MessageRepository } from '../persistence/message-repository'
import { PersistenceError } from '../persistence/persistence-error'
import {
  MAX_CROSS_SESSION_SEARCH_RESULTS,
  MAX_SESSION_SEARCH_LENGTH,
  type SessionRepository,
} from '../persistence/session-repository'
import { messageText } from '../session/canonical-history'

/** Applies result limits after matching visible text, paging past nonmatching Sessions. */
export function findSessionSearchHits(
  reader: PersistenceReader,
  sessions: SessionRepository,
  messages: MessageRepository,
  input: { text: string; projectId?: ProjectId; limit?: number },
): SessionSearchHit[] {
  const text = input.text.trim()
  const limit = input.limit ?? MAX_CROSS_SESSION_SEARCH_RESULTS
  if (!text || text.length > MAX_SESSION_SEARCH_LENGTH) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Session search text must contain between 1 and 256 characters',
    )
  }
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_CROSS_SESSION_SEARCH_RESULTS
  ) {
    throw new PersistenceError(
      'CODEC_INVALID',
      'Session search result limit must be between 1 and 100',
    )
  }
  const needle = text.toLowerCase()
  const hits: SessionSearchHit[] = []
  let before: SessionListCursor | undefined
  do {
    const page = sessions.listPage(reader, {
      projectId: input.projectId,
      lifecycle: 'active',
      before,
      limit: 100,
    })
    for (const session of page.records) {
      if (session.title.toLowerCase().includes(needle)) {
        hits.push({
          session,
          match: { kind: 'title', snippet: boundedSnippet(session.title) },
        })
      } else {
        const message = messages.searchText(reader, session.id, {
          text,
          limit: 1,
        })[0]
        if (message)
          hits.push({
            session,
            match: {
              kind: 'message',
              messageId: message.id,
              seq: message.seq,
              snippet: boundedSnippet(messageText(message)),
            },
          })
      }
      if (hits.length === limit) return hits
    }
    before = page.hasMore ? page.nextBefore : undefined
  } while (before)
  return hits
}

function boundedSnippet(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 512) || '…'
}
