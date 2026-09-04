import { randomUUID } from 'node:crypto'
import {
  fileStatus as stat,
  makeDirectory as mkdir,
  renamePathSync as renameSync,
} from '../common/filesystem'
import path from 'node:path'
import type {
  LoggingConfig,
  OperationalLogLevel,
} from '../../shared/config/application'
import type { DiagnosticId, EventId } from '../../shared/ids'
import { compileSchema } from '../schema-validator'
import {
  clearClosedRuntimeLogs,
  cleanupRuntimeLogs,
  type RuntimeLogCleanupResult,
} from './cleanup'
import {
  OPERATIONAL_LOG_FILE_BYTES,
  OPERATIONAL_LOG_MAX_EVENT_BYTES,
  OPERATIONAL_LOG_SCHEMA_VERSION,
  OperationalLogRecordSchema,
  type OperationalEventInput,
  type OperationalLogRecord,
  type OperationalLogWriteResult,
} from './events'
import {
  OperationalSanitizer,
  type OperationalSanitizerOptions,
} from './sanitizer'

const validateRecord = compileSchema(OperationalLogRecordSchema)
const LEVEL_PRIORITY: Record<OperationalLogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}
const STRING_FIELD_LIMITS: Partial<
  Record<keyof OperationalEventInput, number>
> = {
  sessionId: 128,
  runId: 128,
  providerCallId: 128,
  toolBatchId: 128,
  callId: 128,
  agentExecutionId: 128,
  traceId: 128,
  operation: 64,
  outcome: 64,
  providerId: 128,
  providerType: 128,
  model: 256,
  reasoning: 32,
  outputTokenField: 64,
  wireReasoningEffort: 32,
  thinkingMode: 32,
  toolName: 128,
  executionMode: 64,
  phase: 64,
  approval: 64,
}

export interface OperationalLoggerFactory {
  create(logId: string): OperationalLoggerAdapter
}

export interface OperationalLoggerAdapter {
  error(message: string): void
  warn(message: string): void
  info(message: string): void
  debug(message: string): void
  transports: {
    console: { level: string | false } | null
    ipc?: { level: string | false } | null
    remote?: { level: string | false } | null
    file: {
      level: string | false
      sync: boolean
      maxSize: number
      resolvePathFn: () => string
      format: (options: { data: unknown[] }) => unknown[]
      archiveLogFn: (file: {
        path: string
        clear(): boolean
        on(event: 'error', listener: (error: Error) => void): unknown
      }) => void
      getFile(): {
        isNull?(): boolean
        on(event: 'error', listener: (error: Error) => void): unknown
      }
    }
  }
  errorHandler?: {
    startCatching(options: {
      showDialog: boolean
      onError: (input: { error: Error; errorName: string }) => false
    }): void
    stopCatching(): void
  }
}

export interface OperationalLogStatus {
  enabled: boolean
  level: OperationalLogLevel
  directory: string
  activeFile: string
  degraded: boolean
  warning?: string
}

export interface OperationalLogServiceOptions {
  directory: string
  config: LoggingConfig['operational']
  loggerFactory: OperationalLoggerFactory
  sanitizer?: OperationalSanitizerOptions
  processInstanceId?: string
  now?: () => Date
}

/** Owns safe, bounded JSONL operational logging for the backend process. */
export class OperationalLogService {
  readonly #directory: string
  readonly #activeFile: string
  readonly #logger: OperationalLoggerAdapter
  readonly #sanitizer: OperationalSanitizer
  readonly #processInstanceId: string
  readonly #now: () => Date
  #config: LoggingConfig['operational']
  #seq = 0
  #degraded = false
  #warning: string | undefined
  #fileErrorListenerInstalled = false

  constructor(options: OperationalLogServiceOptions) {
    this.#directory = path.resolve(options.directory)
    this.#activeFile = path.join(this.#directory, 'runtime.current.jsonl')
    this.#config = structuredClone(options.config)
    this.#sanitizer = new OperationalSanitizer(options.sanitizer)
    this.#processInstanceId = options.processInstanceId ?? randomUUID()
    this.#now = options.now ?? (() => new Date())
    this.#logger = options.loggerFactory.create('operational-runtime')
    this.#configureLogger()
    void this.cleanup()
  }

  /** Returns renderer-safe status without exposing log content. */
  status(): OperationalLogStatus {
    return {
      enabled: this.#config.level !== 'off',
      level: this.#config.level,
      directory: this.#directory,
      activeFile: this.#activeFile,
      degraded: this.#degraded,
      ...(this.#warning ? { warning: this.#warning } : {}),
    }
  }

  /** Applies level and retention changes immediately. */
  reconfigure(config: LoggingConfig['operational']): void {
    this.#config = structuredClone(config)
    this.#degraded = false
    this.#warning = undefined
    this.#configureLogger()
    void this.cleanup()
  }

  /** Captures uncaught process failures through electron-log's Node handler. */
  startProcessErrorCapture(): () => void {
    try {
      this.#logger.errorHandler?.startCatching({
        showDialog: false,
        onError: ({ error, errorName }) => {
          this.log({
            level: 'error',
            event: 'process.failed',
            code: 'UNHANDLED_PROCESS_ERROR',
            message: errorName,
            error,
          })
          return false
        },
      })
    } catch (error) {
      this.#markDegraded(error)
    }
    return () => {
      try {
        this.#logger.errorHandler?.stopCatching()
      } catch (error) {
        this.#markDegraded(error)
      }
    }
  }

  /** Writes one allowlisted operational event and never throws. */
  log(input: OperationalEventInput): OperationalLogWriteResult {
    const eventId = `event:${randomUUID()}` as EventId
    const diagnosticId =
      input.diagnosticId ??
      (input.level === 'warn' || input.level === 'error'
        ? (`diagnostic:${randomUUID()}` as DiagnosticId)
        : undefined)
    if (!this.#shouldWrite(input.level)) {
      return { eventId, diagnosticId, written: false }
    }
    try {
      const record = this.#buildRecord(input, eventId, diagnosticId)
      const serialized = JSON.stringify(record)
      if (Buffer.byteLength(serialized) > OPERATIONAL_LOG_MAX_EVENT_BYTES) {
        throw new Error('Operational log record exceeded the 32 KiB limit')
      }
      if (input.level === 'error') this.#logger.error(serialized)
      else if (input.level === 'warn') this.#logger.warn(serialized)
      else if (input.level === 'info') this.#logger.info(serialized)
      else this.#logger.debug(serialized)
      return { eventId, diagnosticId, written: true }
    } catch (error) {
      this.#markDegraded(error)
      return { eventId, diagnosticId, written: false }
    }
  }

  /** Applies age and total-size limits to closed log files. */
  async cleanup(): Promise<RuntimeLogCleanupResult | undefined> {
    try {
      await mkdir(this.#directory, { recursive: true })
      const activeBytes = await stat(this.#activeFile)
        .then((metadata) => metadata.size)
        .catch(() => 0)
      return await cleanupRuntimeLogs({
        directory: this.#directory,
        activeFile: this.#activeFile,
        retentionDays: this.#config.retentionDays,
        maxTotalBytes: Math.max(0, this.#config.maxTotalBytes - activeBytes),
        now: this.#now(),
      })
    } catch (error) {
      this.#markDegraded(error)
      return undefined
    }
  }

  /** Deletes closed logs while preserving the active file. */
  async clearHistory(): Promise<RuntimeLogCleanupResult | undefined> {
    try {
      return await clearClosedRuntimeLogs(this.#directory, this.#activeFile)
    } catch (error) {
      this.#markDegraded(error)
      return undefined
    }
  }

  #configureLogger(): void {
    disableTransport(this.#logger.transports.console)
    disableTransport(this.#logger.transports.ipc)
    disableTransport(this.#logger.transports.remote)
    const file = this.#logger.transports.file
    file.level = this.#config.level === 'off' ? false : this.#config.level
    file.sync = true
    file.maxSize = OPERATIONAL_LOG_FILE_BYTES
    file.resolvePathFn = () => this.#activeFile
    file.format = ({ data }) => [String(data[0] ?? '')]
    file.archiveLogFn = (oldFile) => {
      const timestamp = this.#now().toISOString().replaceAll(/[:.]/gu, '-')
      const archive = path.join(
        this.#directory,
        `runtime.${timestamp}.${randomUUID()}.jsonl`,
      )
      try {
        renameSync(oldFile.path, archive)
        void this.cleanup()
      } catch (error) {
        this.#markDegraded(error)
        oldFile.clear()
      }
    }
    if (this.#config.level !== 'off' && !this.#fileErrorListenerInstalled) {
      try {
        const activeFile = file.getFile()
        if (activeFile.isNull?.()) {
          throw new Error('Operational log file is unavailable')
        }
        activeFile.on('error', (error) => this.#markDegraded(error))
        this.#fileErrorListenerInstalled = true
      } catch (error) {
        this.#markDegraded(error)
      }
    }
  }

  #shouldWrite(level: Exclude<OperationalLogLevel, 'off'>): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.#config.level]
  }

  #buildRecord(
    input: OperationalEventInput,
    eventId: EventId,
    diagnosticId: DiagnosticId | undefined,
  ): OperationalLogRecord {
    const record = {
      schemaVersion: OPERATIONAL_LOG_SCHEMA_VERSION,
      seq: ++this.#seq,
      eventId,
      ts: this.#now().toISOString(),
      level: input.level,
      event: input.event,
      processInstanceId: this.#processInstanceId,
      ...copyDefined(
        input,
        [
          'sessionId',
          'runId',
          'providerCallId',
          'toolBatchId',
          'callId',
          'agentExecutionId',
          'traceId',
          'operation',
          'outcome',
          'providerId',
          'providerType',
          'model',
          'reasoning',
          'messageCount',
          'toolCount',
          'requestBytes',
          'requestFields',
          'outputTokenField',
          'maxOutputTokens',
          'wireReasoningEffort',
          'thinkingMode',
          'responseBytes',
          'httpStatus',
          'retryAfterMs',
          'attempt',
          'maxAttempts',
          'ttftMs',
          'durationMs',
          'promptTokens',
          'completionTokens',
          'reasoningTokens',
          'totalTokens',
          'cacheHitTokens',
          'cacheMissTokens',
          'toolName',
          'executionMode',
          'effects',
          'phase',
          'approval',
          'inputBytes',
          'outputBytes',
          'truncated',
          'itemCount',
          'databaseVersion',
        ],
        this.#sanitizer,
      ),
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(input.code ? { code: this.#sanitizer.text(input.code, 128) } : {}),
      ...(input.message
        ? { message: this.#sanitizer.text(input.message) }
        : {}),
      ...(input.error ? { error: this.#sanitizer.error(input.error) } : {}),
      ...(input.endpoint
        ? { endpoint: this.#sanitizer.endpoint(input.endpoint) }
        : {}),
      ...(input.providerErrorCode
        ? {
            providerErrorCode: this.#sanitizer.text(
              input.providerErrorCode,
              256,
            ),
          }
        : {}),
      ...(input.requestId
        ? { requestId: this.#sanitizer.text(input.requestId, 512) }
        : {}),
    }
    if (!validateRecord(record)) {
      throw new Error('Operational log record failed schema validation')
    }
    return record as OperationalLogRecord
  }

  #markDegraded(error: unknown): void {
    this.#degraded = true
    this.#warning = this.#sanitizer.text(
      error instanceof Error ? error.message : error,
      1_024,
    )
  }
}

function disableTransport(
  transport: { level: string | false } | null | undefined,
): void {
  if (transport) transport.level = false
}

function copyDefined(
  source: OperationalEventInput,
  keys: readonly (keyof OperationalEventInput)[],
  sanitizer: OperationalSanitizer,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    const value = source[key]
    if (value === undefined) continue
    output[key] =
      typeof value === 'string'
        ? sanitizer.text(value, STRING_FIELD_LIMITS[key] ?? 512)
        : Array.isArray(value)
          ? value.map((item) => sanitizer.text(item, 64)).slice(0, 16)
          : value
  }
  return output
}
