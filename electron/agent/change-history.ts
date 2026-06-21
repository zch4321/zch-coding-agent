import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import type { FileChangeRecord } from '../../shared/change-history'
import type { ApprovedToolCall } from './permission-pipeline'
import { writeJsonAtomic } from '../config/atomic-file'
import { PathGuard } from './path-guard'

const MAX_RECORDS = 200
const MAX_HISTORY_BYTES = 50_000_000

interface StoredFileChange extends FileChangeRecord {
  beforeExists: boolean
  afterExists: boolean
  beforeContent: string
  afterContent: string
}

interface ChangeHistoryFile {
  version: 1
  records: StoredFileChange[]
}

export class ChangeHistoryError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'RESOURCE_CHANGED' | 'INVALID_CHANGE',
    message: string,
  ) {
    super(message)
    this.name = 'ChangeHistoryError'
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function publicRecord(record: StoredFileChange): FileChangeRecord {
  return {
    id: record.id,
    conversationId: record.conversationId,
    sessionId: record.sessionId,
    runId: record.runId,
    callId: record.callId,
    workspace: record.workspace,
    path: record.path,
    operation: record.operation,
    diff: record.diff,
    diffHash: record.diffHash,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    createdAt: record.createdAt,
    revertedAt: record.revertedAt,
  }
}

function isStoredRecord(value: unknown): value is StoredFileChange {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'conversationId') === 'string' &&
    typeof Reflect.get(value, 'workspace') === 'string' &&
    typeof Reflect.get(value, 'path') === 'string' &&
    typeof Reflect.get(value, 'beforeContent') === 'string' &&
    typeof Reflect.get(value, 'afterContent') === 'string' &&
    typeof Reflect.get(value, 'beforeExists') === 'boolean' &&
    typeof Reflect.get(value, 'afterExists') === 'boolean',
  )
}

async function currentState(
  guard: PathGuard,
  relativePath: string,
): Promise<{ exists: boolean; content: string; absolutePath: string }> {
  const absolutePath = guard.resolveCandidate(relativePath)

  try {
    const value = await lstat(absolutePath)
    if (value.isSymbolicLink() || !value.isFile()) {
      throw new ChangeHistoryError(
        'RESOURCE_CHANGED',
        'The change target is no longer a regular file',
      )
    }
    const canonical = await realpath(absolutePath)
    guard.assertInside(canonical)
    return {
      exists: true,
      content: await readFile(canonical, 'utf8'),
      absolutePath,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { exists: false, content: '', absolutePath }
    }
    throw error
  }
}

function assertExpectedState(
  state: { exists: boolean; content: string },
  expectedExists: boolean,
  expectedHash: string,
): void {
  if (state.exists !== expectedExists || hash(state.content) !== expectedHash) {
    throw new ChangeHistoryError(
      'RESOURCE_CHANGED',
      'The file changed after this agent change; refusing to overwrite newer work',
    )
  }
}

export class ChangeHistoryStore {
  readonly #filePath: string
  #records: StoredFileChange[] = []
  #mutation = Promise.resolve()

  constructor(filePath: string) {
    this.#filePath = filePath
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
    try {
      const parsed = JSON.parse(
        await readFile(this.#filePath, 'utf8'),
      ) as Partial<ChangeHistoryFile>
      this.#records = Array.isArray(parsed.records)
        ? parsed.records.filter(isStoredRecord).slice(-MAX_RECORDS)
        : []
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
      await this.#write()
    }
  }

  list(conversationId: string, workspace: string): FileChangeRecord[] {
    const normalizedWorkspace = normalizePath(workspace)
    return this.#records
      .filter(
        (record) =>
          record.conversationId === conversationId &&
          normalizePath(record.workspace) === normalizedWorkspace,
      )
      .map(publicRecord)
      .reverse()
  }

  record(input: {
    conversationId: string
    workspace: string
    approvedCall: ApprovedToolCall
    diff: string
  }): Promise<FileChangeRecord | undefined> {
    return this.#enqueue(async () => {
      const precondition = input.approvedCall.resourcePreconditions[0]
      if (!precondition || precondition.expectedResultContent === undefined) {
        return undefined
      }

      const operation = precondition.operation
      const beforeContent = precondition.expectedContent ?? ''
      const afterContent = precondition.expectedResultContent ?? ''
      const record: StoredFileChange = {
        id: `change-${randomUUID()}`,
        conversationId: input.conversationId,
        sessionId: input.approvedCall.sessionId,
        runId: input.approvedCall.runId,
        callId: input.approvedCall.callId,
        workspace: input.workspace,
        path: precondition.path,
        operation,
        diff: input.diff,
        diffHash: input.approvedCall.diffHash,
        beforeHash: hash(beforeContent),
        afterHash: hash(afterContent),
        beforeExists: precondition.expectedExists,
        afterExists: operation !== 'delete',
        beforeContent,
        afterContent,
        createdAt: new Date().toISOString(),
      }
      this.#records.push(record)
      this.#trim()
      await this.#write()
      return publicRecord(record)
    })
  }

  revert(input: {
    id: string
    conversationId: string
    workspace: string
  }): Promise<FileChangeRecord> {
    return this.#enqueue(async () => {
      const record = this.#records.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.conversationId === input.conversationId,
      )
      if (
        !record ||
        normalizePath(record.workspace) !== normalizePath(input.workspace)
      ) {
        throw new ChangeHistoryError('NOT_FOUND', 'Change record was not found')
      }
      if (record.revertedAt) {
        throw new ChangeHistoryError(
          'INVALID_CHANGE',
          'Change was already reverted',
        )
      }

      const guard = await PathGuard.create(record.workspace)
      let state = await currentState(guard, record.path)
      assertExpectedState(state, record.afterExists, record.afterHash)
      const parent = path.dirname(state.absolutePath)
      const parentRealPath = await realpath(parent)
      guard.assertInside(parentRealPath)

      if (record.beforeExists) {
        const temporaryPath = path.join(
          parentRealPath,
          `.${path.basename(state.absolutePath)}.${randomUUID()}.revert`,
        )
        const file = await open(temporaryPath, 'wx', 0o600)
        try {
          await file.writeFile(record.beforeContent, 'utf8')
          await file.sync()
          await file.close()
          state = await currentState(guard, record.path)
          assertExpectedState(state, record.afterExists, record.afterHash)
          await rename(temporaryPath, state.absolutePath)
        } catch (error) {
          await file.close().catch(() => undefined)
          await unlink(temporaryPath).catch(() => undefined)
          throw error
        }
      } else {
        state = await currentState(guard, record.path)
        assertExpectedState(state, true, record.afterHash)
        const temporaryPath = path.join(
          parentRealPath,
          `.${path.basename(state.absolutePath)}.${randomUUID()}.revert-delete`,
        )
        await rename(state.absolutePath, temporaryPath)
        try {
          await unlink(temporaryPath)
        } catch (error) {
          await rename(temporaryPath, state.absolutePath).catch(() => undefined)
          throw error
        }
      }

      record.revertedAt = new Date().toISOString()
      await this.#write()
      return publicRecord(record)
    })
  }

  #enqueue<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#mutation.then(operation)
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #trim(): void {
    this.#records = this.#records.slice(-MAX_RECORDS)
    while (
      this.#records.length > 1 &&
      Buffer.byteLength(
        JSON.stringify({ version: 1, records: this.#records }),
      ) > MAX_HISTORY_BYTES
    ) {
      this.#records.shift()
    }
  }

  #write(): Promise<void> {
    return writeJsonAtomic(this.#filePath, {
      version: 1,
      records: this.#records,
    } satisfies ChangeHistoryFile)
  }
}
