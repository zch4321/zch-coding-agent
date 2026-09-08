import {
  BACKGROUND_PAGE_SIZE,
  backgroundTaskKey,
  compareBackgroundTasks,
  isBackgroundTaskActive,
  type BackgroundTask,
  type BackgroundTaskPage,
  type BackgroundTaskTarget,
  type BackgroundTerminalTail,
} from '../../shared/background-tasks'
import type { AgentExecutionId, SessionId, TerminalId } from '../../shared/ids'
import type { BackgroundTaskService } from '../background/service'
import type { RuntimeEventBus } from '../runtime/runtime-event-bus'
import type { TerminalPool } from '../terminal/pool'
import { readTerminalArtifactTail } from '../terminal/artifact-tail'
import { SessionRepository } from '../persistence/session-repository'
import { SubagentRepository } from '../persistence/subagent-repository'
import { projectAgentExecutionSummary } from '../subagent/public-projection'
import type { ApplicationStateCoordinator } from './application-state-coordinator'
import { ApplicationError } from './application-error'

interface PageCursor {
  backendInstanceId: string
  parentSessionId: string
  active: boolean
  createdAt: string
  key: string
}
interface BackgroundApplicationOptions {
  coordinator: ApplicationStateCoordinator
  events: RuntimeEventBus
  terminals: TerminalPool
  tasks: BackgroundTaskService
  stopRequested: (executionId: AgentExecutionId) => boolean
}

/** Projects durable Agent roots and process-local terminals through owner-checked UI capabilities. */
export class BackgroundTaskApplicationService {
  readonly #options: BackgroundApplicationOptions
  readonly #sessions = new SessionRepository()
  readonly #subagents = new SubagentRepository()

  constructor(options: BackgroundApplicationOptions) {
    this.#options = options
  }

  /** Returns one bounded active-first page and the exact count of active roots and terminals. */
  async list(input: {
    parentSessionId: SessionId
    before?: string
  }): Promise<BackgroundTaskPage> {
    const { coordinator, events, terminals, stopRequested } = this.#options
    const before = input.before
      ? this.#decodeCursor(input.before, input.parentSessionId)
      : undefined
    return (
      await coordinator.query((reader) => {
        if (!this.#sessions.get(reader, input.parentSessionId))
          throw new ApplicationError(
            'NOT_FOUND',
            'Parent Session was not found',
          )
        const agents: BackgroundTask[] = this.#subagents
          .listBackgroundRoots(reader, {
            ...input,
            before,
            limit: BACKGROUND_PAGE_SIZE + 1,
          })
          .map((entry) => ({
            kind: 'agent',
            summary: {
              ...projectAgentExecutionSummary(entry.record, {
                ...(entry.childSessionId
                  ? {
                      child: this.#sessions.getAny(
                        reader,
                        entry.childSessionId,
                      ),
                    }
                  : {}),
                ...(entry.record.kind === 'swarm'
                  ? {
                      agentCounts: this.#subagents.childCounts(
                        reader,
                        entry.record.id,
                      ),
                    }
                  : {}),
              }),
              stopRequested: stopRequested(entry.record.id),
            },
          }))
        const terminalTasks: BackgroundTask[] = terminals
          .listBackground(input.parentSessionId)
          .map((terminal) => ({
            kind: 'terminal',
            terminalId: terminal.terminalId,
            shell: terminal.shell,
            status: terminal.status,
            exitCode: terminal.exitCode,
            createdAt: terminal.createdAt,
            artifactAvailable: terminal.artifactAvailable,
            ...(terminal.captureError
              ? { captureError: terminal.captureError.slice(0, 2048) }
              : {}),
          }))
        const records = [
          ...agents,
          ...terminalTasks.filter(
            (task) => !before || afterCursor(task, before),
          ),
        ].sort(compareBackgroundTasks)
        const page = records.slice(0, BACKGROUND_PAGE_SIZE)
        const last = page.at(-1)
        return {
          cursor: events.cursor,
          records: page,
          activeCount:
            this.#subagents.countActiveRoots(reader, input.parentSessionId) +
            terminalTasks.filter(isBackgroundTaskActive).length,
          hasMore: records.length > page.length,
          ...(records.length > page.length && last
            ? {
                nextBefore: Buffer.from(
                  JSON.stringify({
                    ...position(last),
                    parentSessionId: input.parentSessionId,
                    backendInstanceId: coordinator.backendInstanceId,
                  }),
                ).toString('base64url'),
              }
            : {}),
        }
      })
    ).value
  }

  /** Requests idempotent cancellation after validating instance and public-parent ownership. */
  async cancel(input: {
    parentSessionId: SessionId
    backendInstanceId: string
    target: BackgroundTaskTarget
  }): Promise<{ accepted: boolean }> {
    await this.#requireParent(input)
    try {
      const accepted = await this.#options.tasks.cancelOwned(
        input.parentSessionId,
        input.target,
      )
      this.#options.events.publishBackground(input.parentSessionId)
      return { accepted }
    } catch (error) {
      this.#options.events.publishBackground(input.parentSessionId)
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        error instanceof Error
          ? error.message.slice(0, 2048)
          : 'Failed to stop background task',
      )
    }
  }

  /** Reads only the registered terminal log, never renderer-supplied filesystem paths. */
  async tail(input: {
    parentSessionId: SessionId
    backendInstanceId: string
    terminalId: TerminalId
  }): Promise<BackgroundTerminalTail> {
    await this.#requireParent(input)
    let artifact: ReturnType<TerminalPool['backgroundArtifact']>
    try {
      artifact = this.#options.terminals.backgroundArtifact(
        input.parentSessionId,
        input.terminalId,
      )
    } catch {
      throw new ApplicationError(
        'NOT_FOUND',
        'Terminal was not found for this Session',
      )
    }
    try {
      if (!artifact) throw new Error('Terminal log is unavailable')
      if (artifact.captureError) throw new Error(artifact.captureError)
      const tail = await readTerminalArtifactTail(artifact)
      return { ...tail, available: true, cursor: this.#options.events.cursor }
    } catch (error) {
      return {
        content: '',
        truncated: false,
        available: false,
        cursor: this.#options.events.cursor,
        error:
          error instanceof Error
            ? error.message.slice(0, 2048)
            : 'Terminal log could not be read',
      }
    }
  }

  async #requireParent(input: {
    parentSessionId: SessionId
    backendInstanceId: string
  }): Promise<void> {
    const { coordinator } = this.#options
    if (input.backendInstanceId !== coordinator.backendInstanceId)
      throw new ApplicationError(
        'RESOURCE_CHANGED',
        'Backend restarted; reload background tasks',
      )
    await coordinator.query((reader) => {
      if (!this.#sessions.get(reader, input.parentSessionId))
        throw new ApplicationError('NOT_FOUND', 'Parent Session was not found')
    })
  }

  #decodeCursor(value: string, parentSessionId: SessionId): PageCursor {
    try {
      const cursor = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as PageCursor
      if (
        cursor.parentSessionId !== parentSessionId ||
        cursor.backendInstanceId !==
          this.#options.coordinator.backendInstanceId ||
        typeof cursor.active !== 'boolean' ||
        typeof cursor.key !== 'string' ||
        typeof cursor.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(cursor.createdAt))
      )
        throw new Error('Invalid cursor')
      return cursor
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Background page cursor is invalid or expired',
      )
    }
  }
}

function position(task: BackgroundTask) {
  return {
    active: isBackgroundTaskActive(task),
    createdAt: task.kind === 'agent' ? task.summary.createdAt : task.createdAt,
    key: backgroundTaskKey(task),
  }
}

function afterCursor(task: BackgroundTask, cursor: PageCursor): boolean {
  const current = position(task)
  return (
    Number(current.active) < Number(cursor.active) ||
    (current.active === cursor.active &&
      (current.createdAt < cursor.createdAt ||
        (current.createdAt === cursor.createdAt && current.key < cursor.key)))
  )
}
