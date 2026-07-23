import { randomUUID } from 'node:crypto'
import type {
  DurableCommandResult,
  DurableCommitEnvelope,
  DurableCommitFor,
  DurableCommitTopic,
  FileChangeCommittedChange,
  ProjectCommittedChange,
  SessionCommittedChange,
} from '../../shared/domain-state-api'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from '../persistence/database-service'
import { DatabaseService } from '../persistence/database-service'
import { normalizeApplicationError } from './application-error'

type DurableChangeFor<Topic extends DurableCommitTopic> =
  Topic extends 'project.changed'
    ? ProjectCommittedChange
    : Topic extends 'session.changed'
      ? SessionCommittedChange
      : FileChangeCommittedChange

export interface ApplicationStateCoordinatorOptions {
  database: DatabaseService
  publish?: (envelope: DurableCommitEnvelope) => void | Promise<void>
  backendInstanceId?: string
  onDiagnostic?: (message: string, error?: unknown) => void
}

export class ApplicationStateCoordinator {
  readonly backendInstanceId: string
  readonly #database: DatabaseService
  readonly #publish?: (envelope: DurableCommitEnvelope) => void | Promise<void>
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  #sequence = 0
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ApplicationStateCoordinatorOptions) {
    this.#database = options.database
    this.#publish = options.publish
    this.backendInstanceId =
      options.backendInstanceId ?? `backend:${randomUUID()}`
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  get cursor() {
    return {
      schemaVersion: 1 as const,
      backendInstanceId: this.backendInstanceId,
      sequence: this.#sequence,
    }
  }

  query<Result>(work: (reader: PersistenceReader) => Result): Promise<{
    cursor: ReturnType<ApplicationStateCoordinator['getCursor']>
    value: Result
  }> {
    return this.#enqueue(() => {
      try {
        const value = this.#database.read(work)
        return { cursor: this.getCursor(), value }
      } catch (error) {
        throw normalizeApplicationError(error)
      }
    })
  }

  command<Topic extends DurableCommitTopic>(
    topic: Topic,
    work: (transaction: PersistenceTransaction) => DurableChangeFor<Topic>,
  ): Promise<DurableCommandResult<Topic>> {
    return this.#enqueue(async () => {
      let change: DurableChangeFor<Topic>
      try {
        change = await this.#database.withTransaction(work)
      } catch (error) {
        throw normalizeApplicationError(error)
      }

      this.#sequence += 1
      const commit = immutable({
        schemaVersion: 1,
        cursor: this.getCursor(),
        topic,
        change,
      }) as unknown as DurableCommitFor<Topic>
      if (this.#publish) {
        try {
          await this.#publish(commit)
        } catch (error) {
          this.#onDiagnostic(
            `Durable commit ${topic} was saved but publication failed`,
            error,
          )
        }
      }
      return { version: 1, commit }
    })
  }

  getCursor() {
    return this.cursor
  }

  #enqueue<Result>(work: () => Result | Promise<Result>): Promise<Result> {
    const result = this.#tail.then(work, work)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function immutable<Value>(value: Value): Readonly<Value> {
  return freezeRecursively(structuredClone(value))
}

function freezeRecursively<Value>(value: Value): Readonly<Value> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) freezeRecursively(child)
  return Object.freeze(value)
}
