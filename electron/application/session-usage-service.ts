import type { RunId, SessionId } from '../../shared/ids'
import type { SessionUsageSnapshot } from '../../shared/session-usage'
import {
  SessionUsageRepository,
  type UsageCallInput,
} from '../persistence/session-usage-repository'
import { SessionRepository } from '../persistence/session-repository'
import { MessageRepository } from '../persistence/message-repository'
import type { CompiledProviderCall } from '../providers/provider'
import {
  buildContextUsage,
  measureContextTools,
  type ContextUsageRecipe,
} from '../session/context-usage'
import type { SessionState } from '../session/session-types'
import { ApplicationError } from './application-error'
import type { ApplicationStateCoordinator } from './application-state-coordinator'

export interface SessionUsagePort {
  startRun(sessionId: SessionId, runId: RunId): Promise<void>
  record(input: UsageCallInput): Promise<void>
  capture(session: SessionState, compiled?: CompiledProviderCall): Promise<void>
}

/** Owns durable usage facts and current context snapshots independently from Session revisions. */
export class SessionUsageService implements SessionUsagePort {
  readonly #repository = new SessionUsageRepository()
  readonly #sessions = new SessionRepository()
  readonly #messages = new MessageRepository()

  constructor(
    private readonly options: {
      coordinator: ApplicationStateCoordinator
      onDiagnostic?: (message: string, error?: unknown) => void
    },
  ) {}

  /** Advances the public Run selector before compaction, without registering a pending call. */
  async startRun(sessionId: SessionId, runId: RunId): Promise<void> {
    try {
      const changed = await this.options.coordinator.internalCommand((tx) => {
        if (!this.#sessions.get(tx, sessionId)) return false
        const previous = this.#repository.context(tx, sessionId)
        this.#repository.saveContext(tx, sessionId, {
          revision: 0,
          snapshot: null,
          recipe: null,
          ...previous,
          runId,
        })
        return true
      })
      if (changed) await this.#notify(sessionId)
    } catch (error) {
      this.options.onDiagnostic?.('Session usage Run selection failed', error)
    }
  }

  /** Saves received usage without allowing accounting failures to interrupt execution. */
  async record(input: UsageCallInput): Promise<void> {
    try {
      const owner = await this.options.coordinator.internalCommand((tx) =>
        this.#repository.insert(tx, input),
      )
      if (owner) await this.#notify(owner)
    } catch (error) {
      this.options.onDiagnostic?.('Session usage persistence failed', error)
    }
  }

  /** Captures committed public history at valid Run and tool-batch boundaries. */
  async capture(
    session: SessionState,
    compiled?: CompiledProviderCall,
  ): Promise<void> {
    const run = session.activeRun
    const binding = run?.routes?.main
    if (session.visibility !== 'public' || !run || !binding) return
    try {
      const changed = await this.options.coordinator.internalCommand((tx) => {
        const record = this.#sessions.get(tx, session.sessionId)
        if (!record) return false
        const previous = this.#repository.context(tx, session.sessionId)
        const previousRecipe = previous?.recipe
          ? (JSON.parse(previous.recipe) as ContextUsageRecipe)
          : undefined
        const recipe: ContextUsageRecipe = {
          runId: run.runId,
          route: binding.snapshot,
          tools: compiled
            ? measureContextTools(compiled)
            : (previousRecipe?.tools ?? { bytes: 0, count: 0, entries: [] }),
        }
        const snapshot = buildContextUsage(
          this.#messages.listActiveHistory(tx, session.sessionId),
          recipe,
        )
        if (
          previous?.snapshot?.sourceHash === snapshot.sourceHash &&
          previous.revision === record.revision
        )
          return false
        this.#repository.saveContext(tx, session.sessionId, {
          runId: run.runId,
          revision: record.revision,
          snapshot,
          recipe: JSON.stringify(recipe),
        })
        return true
      })
      if (changed) await this.#notify(session.sessionId)
    } catch (error) {
      this.options.onDiagnostic?.('Session context capture failed', error)
    }
  }

  /** Reads independent statistics and refreshes changed history without rereading workspace files. */
  async get(sessionId: SessionId): Promise<SessionUsageSnapshot> {
    return this.options.coordinator.internalCommand((tx) => {
      const session = this.#sessions.get(tx, sessionId)
      if (!session) throw new ApplicationError('NOT_FOUND', 'Session not found')
      let stored = this.#repository.context(tx, sessionId)
      if (stored?.recipe && stored.revision !== session.revision) {
        const recipe = JSON.parse(stored.recipe) as ContextUsageRecipe
        let snapshot: SessionUsageSnapshot['context'] = null
        try {
          snapshot = buildContextUsage(
            this.#messages.listActiveHistory(tx, sessionId),
            recipe,
          )
        } catch (error) {
          this.options.onDiagnostic?.(
            'Session context projection is unavailable',
            error,
          )
        }
        stored = {
          ...stored,
          revision: session.revision,
          snapshot,
        }
        this.#repository.saveContext(tx, sessionId, stored)
      }
      const runId = stored?.runId ?? this.#repository.latestRun(tx, sessionId)
      return {
        sessionId,
        context: stored?.snapshot ?? null,
        all: this.#repository.summary(tx, sessionId),
        currentRun: runId
          ? { runId, summary: this.#repository.summary(tx, sessionId, runId) }
          : null,
        header: this.#repository.header(tx, sessionId, runId),
      }
    })
  }

  async #notify(sessionId: SessionId): Promise<void> {
    await this.options.coordinator.command('session.usage.changed', () => ({
      sessionId,
    }))
  }
}
