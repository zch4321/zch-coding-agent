import {
  MAX_AGENT_EXECUTION_PAGE_RECORDS,
  type AgentExecutionDetail,
  type AgentExecutionListCursor,
  type AgentExecutionSummaryPage,
} from '../../shared/agent-execution'
import { MAX_MESSAGE_PAGE_RECORDS } from '../../shared/durable'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { ActiveRunPublicSnapshot } from '../../shared/runtime-state'
import { MessageRepository } from '../persistence/message-repository'
import { SessionRepository } from '../persistence/session-repository'
import { SubagentRepository } from '../persistence/subagent-repository'
import {
  projectAgentExecutionActivities,
  projectAgentExecutionLiveOverlay,
  projectAgentExecutionSummary,
  projectAgentExecutionTask,
} from '../subagent/public-projection'
import type { ApplicationStateCoordinator } from './application-state-coordinator'
import { ApplicationError } from './application-error'

/** Serves parent-scoped, renderer-safe views over hidden delegated executions. */
export class AgentExecutionQueryService {
  readonly #coordinator: ApplicationStateCoordinator
  readonly #sessions: SessionRepository
  readonly #messages: MessageRepository
  readonly #subagents: SubagentRepository
  readonly #liveSnapshot?: (
    sessionId: SessionId,
  ) => ActiveRunPublicSnapshot | undefined

  constructor(options: {
    coordinator: ApplicationStateCoordinator
    sessions?: SessionRepository
    messages?: MessageRepository
    subagents?: SubagentRepository
    liveSnapshot?: (sessionId: SessionId) => ActiveRunPublicSnapshot | undefined
  }) {
    this.#coordinator = options.coordinator
    this.#sessions = options.sessions ?? new SessionRepository()
    this.#messages = options.messages ?? new MessageRepository()
    this.#subagents = options.subagents ?? new SubagentRepository()
    this.#liveSnapshot = options.liveSnapshot
  }

  /** Lists execution summaries owned by one public parent Session. */
  async list(input: {
    parentSessionId: SessionId
    before?: AgentExecutionListCursor
    limit?: number
  }): Promise<AgentExecutionSummaryPage> {
    const limit = boundedLimit(
      input.limit ?? 50,
      MAX_AGENT_EXECUTION_PAGE_RECORDS,
    )
    return (
      await this.#coordinator.query((reader) => {
        this.#requirePublicParent(reader, input.parentSessionId)
        const page = this.#subagents.listByParentSession(reader, {
          parentSessionId: input.parentSessionId,
          before: input.before,
          limit,
        })
        return {
          schemaVersion: 1 as const,
          records: page.records.map((entry) =>
            projectAgentExecutionSummary(
              entry.record,
              entry.childSessionId
                ? { child: this.#sessions.getAny(reader, entry.childSessionId) }
                : {},
            ),
          ),
          hasMore: page.hasMore,
          ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        }
      })
    ).value
  }

  /** Loads one execution's safe activity page after verifying parent ownership. */
  async get(input: {
    parentSessionId: SessionId
    executionId: AgentExecutionId
    beforeSeq?: number
    limit?: number
  }): Promise<AgentExecutionDetail> {
    const limit = boundedLimit(input.limit ?? 100, MAX_MESSAGE_PAGE_RECORDS)
    return (
      await this.#coordinator.query((reader) => {
        this.#requirePublicParent(reader, input.parentSessionId)
        const entry = this.#subagents.getOwned(reader, input)
        if (!entry) {
          throw new ApplicationError(
            'NOT_FOUND',
            'Agent execution was not found for this Session',
          )
        }
        const child = entry.childSessionId
          ? this.#sessions.getAny(reader, entry.childSessionId)
          : undefined
        const page = entry.childSessionId
          ? this.#messages.listVisibleAgentPage(reader, entry.childSessionId, {
              beforeSeq: input.beforeSeq,
              limit,
            })
          : undefined
        const taskRecord = entry.childSessionId
          ? this.#messages.firstVisibleUserInput(reader, entry.childSessionId)
          : undefined
        const task = projectAgentExecutionTask(taskRecord)
        const live = projectAgentExecutionLiveOverlay(
          entry.childSessionId
            ? this.#liveSnapshot?.(entry.childSessionId)
            : undefined,
        )
        return {
          schemaVersion: 1 as const,
          summary: projectAgentExecutionSummary(entry.record, { child }),
          ...(task ? { task } : {}),
          ...(live ? { live } : {}),
          statistics: {
            toolCallCount: entry.childSessionId
              ? this.#messages.countVisibleAgentToolCalls(
                  reader,
                  entry.childSessionId,
                )
              : 0,
          },
          activityPage: {
            schemaVersion: 1 as const,
            records: projectAgentExecutionActivities(page?.records ?? []),
            hasMore: page?.hasMore ?? false,
            ...(page?.hasMore ? { nextBeforeSeq: page.nextBeforeSeq } : {}),
          },
        }
      })
    ).value
  }

  #requirePublicParent(
    reader: Parameters<SessionRepository['get']>[0],
    sessionId: SessionId,
  ): void {
    if (!this.#sessions.get(reader, sessionId)) {
      throw new ApplicationError('NOT_FOUND', 'Parent Session was not found')
    }
  }
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      `Agent execution page limit must be between 1 and ${maximum}`,
    )
  }
  return value
}
