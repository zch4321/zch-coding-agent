import { randomUUID } from 'node:crypto'
import type {
  DurableCommandResult,
  DurableCommitEnvelope,
  DurableCommitFor,
  DurableCommitTopic,
  ProjectCommittedChange,
  SessionCommittedChange,
  SessionRemovedChange,
} from '../../shared/domain-state-api'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from '../persistence/database-service'
import { DatabaseService } from '../persistence/database-service'
import {
  ApplicationError,
  normalizeApplicationError,
} from './application-error'

type DurableChangeFor<Topic extends DurableCommitTopic> =
  Topic extends 'project.changed'
    ? ProjectCommittedChange
    : Topic extends 'session.changed'
      ? SessionCommittedChange
      : Topic extends 'session.removed'
        ? SessionRemovedChange
        : never

export interface ApplicationStateCoordinatorOptions {
  database: DatabaseService
  publish?: (envelope: DurableCommitEnvelope) => void | Promise<void>
  backendInstanceId?: string
  onDiagnostic?: (message: string, error?: unknown) => void
}

/**
 * 串行协调所有 durable state 的读取、事务提交和变更发布。
 *
 * 同一队列中的命令会依次完成“提交事务、分配事件游标、发布提交结果”三个阶段，
 * 读取也通过该队列获取快照，避免调用方观察到已提交但尚未分配游标的中间状态。
 */
export class ApplicationStateCoordinator {
  readonly backendInstanceId: string
  readonly #database: DatabaseService
  readonly #publish?: (envelope: DurableCommitEnvelope) => void | Promise<void>
  readonly #onDiagnostic: (message: string, error?: unknown) => void
  #sequence = 0
  #tail: Promise<void> = Promise.resolve()
  #acceptingWork = true
  #closePromise?: Promise<void>

  /**
   * 创建协调器，并为当前 backend 实例准备独立的事件游标命名空间。
   */
  constructor(options: ApplicationStateCoordinatorOptions) {
    this.#database = options.database
    this.#publish = options.publish
    this.backendInstanceId =
      options.backendInstanceId ?? `backend:${randomUUID()}`
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
  }

  /**
   * 返回当前已发布 durable commit 的游标。
   *
   * 该游标仅用于同一 backend 实例内的事件顺序与去重，不是数据库中的领域 revision。
   */
  get cursor() {
    return {
      schemaVersion: 1 as const,
      backendInstanceId: this.backendInstanceId,
      sequence: this.#sequence,
    }
  }

  /**
   * 在协调队列中执行只读查询，并返回与查询结果一致的事件游标。
   */
  query<Result>(work: (reader: PersistenceReader) => Result): Promise<{
    cursor: ReturnType<ApplicationStateCoordinator['getCursor']>
    value: Result
  }> {
    if (!this.#acceptingWork) {
      return Promise.reject(
        new ApplicationError('PERSISTENCE_FAILURE', 'Backend state is closed'),
      )
    }
    return this.#enqueue(() => {
      try {
        const value = this.#database.read(work)
        return { cursor: this.getCursor(), value }
      } catch (error) {
        throw normalizeApplicationError(error)
      }
    })
  }

  /**
   * 串行执行一次 durable state 事务，并在成功后发布不可变的提交 envelope。
   *
   * 发布失败不会回滚已经成功的数据库事务，只会通过诊断回调报告问题。
   */
  command<Topic extends DurableCommitTopic>(
    topic: Topic,
    work: (transaction: PersistenceTransaction) => DurableChangeFor<Topic>,
  ): Promise<DurableCommandResult<Topic>> {
    if (!this.#acceptingWork) {
      return Promise.reject(
        new ApplicationError('PERSISTENCE_FAILURE', 'Backend state is closed'),
      )
    }
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

  /** Runs a serialized backend-private transaction without publishing a renderer commit. */
  internalCommand<Result>(
    work: (transaction: PersistenceTransaction) => Result,
  ): Promise<Result> {
    if (!this.#acceptingWork) {
      return Promise.reject(
        new ApplicationError('PERSISTENCE_FAILURE', 'Backend state is closed'),
      )
    }
    return this.#enqueue(async () => {
      try {
        return await this.#database.withTransaction(work)
      } catch (error) {
        throw normalizeApplicationError(error)
      }
    })
  }

  /**
   * 以方法形式返回当前游标，供需要稳定函数签名的调用方使用。
   */
  getCursor() {
    return this.cursor
  }

  /** Stops accepting work and resolves after every queued command is settled. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#acceptingWork = false
    this.#closePromise = this.#tail
    return this.#closePromise
  }

  /**
   * 将工作追加到串行队列。
   *
   * 前一项失败后仍会继续执行后续工作，避免一次失败使整个状态协调器停滞。
   */
  #enqueue<Result>(work: () => Result | Promise<Result>): Promise<Result> {
    const result = this.#tail.then(work, work)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * 深拷贝并冻结提交内容，防止发布后被调用方修改。
 */
function immutable<Value>(value: Value): Readonly<Value> {
  return freezeRecursively(structuredClone(value))
}

/**
 * 递归冻结对象及其子对象；原始值和已冻结对象直接返回。
 */
function freezeRecursively<Value>(value: Value): Readonly<Value> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) freezeRecursively(child)
  return Object.freeze(value)
}
