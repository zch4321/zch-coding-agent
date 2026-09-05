import { createHash } from 'node:crypto'
import { accessPath as access } from '../common/filesystem'
import path from 'node:path'
import type { AgentExecutionStatus } from '../../shared/agent-execution'
import { delay } from '../../shared/async/delay'
import type { AgentExecutionId, SessionId, TerminalId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { BackgroundTaskTarget } from '../../shared/background-tasks'
import type { SubagentStateService } from '../application/subagent-state-service'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import type { PreparedSubagentExecutionPort } from '../subagent/contracts'
import type { SwarmExecutionPort } from '../swarm/contracts'
import {
  TERMINAL_BACKGROUND_TAIL_LINES,
  type TerminalBackgroundSnapshot,
  type TerminalPool,
} from '../terminal/pool'
import type { BackgroundAgentHandleRegistry } from './agent-handle-registry'
import {
  BackgroundTaskError,
  type BackgroundCancelInput,
  type BackgroundListInput,
  type BackgroundTarget,
  type BackgroundTaskPort,
  type BackgroundWaitInput,
} from './contracts'

const ACTIVE_AGENT_STATUSES = new Set<AgentExecutionStatus>([
  'queued',
  'preparing',
  'running',
])
const POLL_INTERVAL_MS = 100

interface ListCursor {
  version: 1
  queryHash: string
  createdAt: string
  id: string
  type: BackgroundTarget['type']
}

interface ListedSnapshot {
  createdAt: string
  id: string
  type: BackgroundTarget['type']
  value: Record<string, JsonValue>
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function queryHash(
  input: Pick<BackgroundListInput, 'parentSessionId' | 'types' | 'status'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        parentSessionId: input.parentSessionId,
        types: [...(input.types ?? [])].sort(),
        status: input.status,
      }),
    )
    .digest('hex')
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, expectedQueryHash: string): ListCursor {
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<ListCursor>
    if (
      cursor.version !== 1 ||
      cursor.queryHash !== expectedQueryHash ||
      typeof cursor.createdAt !== 'string' ||
      typeof cursor.id !== 'string' ||
      (cursor.type !== 'subagent' &&
        cursor.type !== 'swarm' &&
        cursor.type !== 'terminal')
    ) {
      throw new Error('Invalid cursor')
    }
    return cursor as ListCursor
  } catch {
    throw new BackgroundTaskError(
      'BACKGROUND_CURSOR_INVALID',
      'background_list cursor is invalid or belongs to different filters',
    )
  }
}

function terminalId(value: number): TerminalId {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BackgroundTaskError(
      'BACKGROUND_TARGET_INVALID',
      'Terminal target id must be a positive integer',
    )
  }
  return value as TerminalId
}

function agentTerminal(status: AgentExecutionStatus): boolean {
  return !ACTIVE_AGENT_STATUSES.has(status)
}

function terminalTerminal(
  status: TerminalBackgroundSnapshot['status'],
): boolean {
  return status === 'closed' || status === 'failed'
}

function snapshotTerminal(value: Record<string, JsonValue>): boolean {
  return value.type === 'terminal'
    ? value.status === 'closed' || value.status === 'failed'
    : typeof value.status === 'string' &&
        !ACTIVE_AGENT_STATUSES.has(value.status as AgentExecutionStatus)
}

function compareListed(left: ListedSnapshot, right: ListedSnapshot): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.type.localeCompare(left.type) ||
    right.id.localeCompare(left.id)
  )
}

function boundedError(
  error: SubagentExecutionRecord['error'],
): SubagentExecutionRecord['error'] | undefined {
  return error
    ? { code: error.code.slice(0, 128), message: error.message.slice(0, 2_048) }
    : undefined
}

function isAfterCursor(value: ListedSnapshot, cursor: ListCursor): boolean {
  return (
    value.createdAt < cursor.createdAt ||
    (value.createdAt === cursor.createdAt &&
      (value.type < cursor.type ||
        (value.type === cursor.type && value.id < cursor.id)))
  )
}

function compactListValue(
  value: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return {
    type: value.type ?? 'subagent',
    id: typeof value.id === 'number' ? value.id : 0,
    ...(typeof value.terminalId === 'number'
      ? { terminalId: value.terminalId }
      : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    status: value.status ?? 'failed',
    terminal: value.terminal === true,
    ...(typeof value.exitCode === 'number' || value.exitCode === null
      ? { exitCode: value.exitCode }
      : {}),
    ...(typeof value.createdAt === 'string'
      ? { createdAt: value.createdAt }
      : {}),
    ...(typeof value.updatedAt === 'string'
      ? { updatedAt: value.updatedAt }
      : {}),
  }
}

function listResultBytes(
  items: readonly ListedSnapshot[],
  query: Pick<ListCursor, 'queryHash'>,
): number {
  const last = items.at(-1)
  return Buffer.byteLength(
    JSON.stringify({
      tasks: items.map((item) => item.value),
      hasMore: true,
      ...(last
        ? {
            nextCursor: encodeCursor({
              version: 1,
              queryHash: query.queryHash,
              createdAt: last.createdAt,
              id: last.id,
              type: last.type,
            }),
          }
        : {}),
    }),
    'utf8',
  )
}

/** Uses SQLite and PTY ownership as authority for all background task operations. */
export class BackgroundTaskService implements BackgroundTaskPort {
  readonly #state: SubagentStateService
  readonly #subagents: PreparedSubagentExecutionPort
  readonly #swarms: SwarmExecutionPort
  readonly #terminals: TerminalPool
  readonly #handles: BackgroundAgentHandleRegistry

  constructor(options: {
    state: SubagentStateService
    subagents: PreparedSubagentExecutionPort
    swarms: SwarmExecutionPort
    terminals: TerminalPool
    handles: BackgroundAgentHandleRegistry
  }) {
    this.#state = options.state
    this.#subagents = options.subagents
    this.#swarms = options.swarms
    this.#terminals = options.terminals
    this.#handles = options.handles
  }

  /** Waits for any/all requested targets to reach a terminal lifecycle state. */
  async wait(input: BackgroundWaitInput): Promise<JsonValue> {
    const startedAt = performance.now()
    let snapshots = await this.#snapshots(input, true)
    const satisfied = () =>
      input.mode === 'all'
        ? snapshots.every(snapshotTerminal)
        : snapshots.some(snapshotTerminal)
    while (!satisfied() && performance.now() - startedAt < input.timeoutMs) {
      const remaining = input.timeoutMs - (performance.now() - startedAt)
      await delay(Math.min(POLL_INTERVAL_MS, remaining), input.signal)
      snapshots = await this.#snapshots(input, true)
    }
    snapshots = this.#attachTerminalWaitOutput(input, snapshots)
    return json({
      mode: input.mode,
      timedOut: !satisfied(),
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      targets: snapshots,
    })
  }

  /** Lists newest root Agent tasks and Terminals with an opaque filter-bound cursor. */
  async list(input: BackgroundListInput): Promise<JsonValue> {
    const hash = queryHash(input)
    const cursor = input.cursor ? decodeCursor(input.cursor, hash) : undefined
    const allowedTypes = new Set(
      input.types ?? ['subagent', 'swarm', 'terminal'],
    )
    const roots: SubagentExecutionRecord[] = []
    let before = cursor
      ? {
          createdAt: cursor.createdAt,
          executionId: (cursor.type === 'terminal'
            ? '\uffff'
            : cursor.id) as AgentExecutionId,
        }
      : undefined
    let hasMoreAgents = true
    while (hasMoreAgents && roots.length < input.limit + 1) {
      const page = await this.#state.listRoots({
        parentSessionId: input.parentSessionId,
        before,
        limit: 100,
      })
      for (const record of page.records) {
        if (!allowedTypes.has(record.kind)) continue
        if (!this.#matchesStatus(record.status, input.status)) continue
        roots.push(record)
      }
      hasMoreAgents = page.hasMore
      before = page.nextBefore
      if (!page.hasMore) break
    }
    const agentItems = await Promise.all(
      roots.map(async (record): Promise<ListedSnapshot> => {
        const id = this.#handles.expose({
          executionId: record.id,
          parentSessionId: record.parentSessionId,
          type: record.kind,
        })
        return {
          createdAt: record.createdAt,
          id: record.id,
          type: record.kind,
          value: await this.#agentSnapshot(
            input.parentSessionId,
            input.sessionTemp,
            { type: record.kind, id },
            false,
          ),
        }
      }),
    )
    const terminalItems = allowedTypes.has('terminal')
      ? this.#terminals
          .listBackground(input.parentSessionId)
          .filter((terminal) =>
            this.#matchesStatus(
              terminalTerminal(terminal.status) ? 'completed' : 'running',
              input.status,
            ),
          )
          .map<ListedSnapshot>((terminal) => ({
            createdAt: terminal.createdAt,
            id: String(terminal.terminalId),
            type: 'terminal',
            value: this.#terminalSnapshotValue(terminal),
          }))
      : []
    const combined = [...agentItems, ...terminalItems]
      .filter((item) => !cursor || isAfterCursor(item, cursor))
      .sort(compareListed)
    const page: ListedSnapshot[] = []
    for (const item of combined) {
      if (page.length >= input.limit) break
      let candidate = item
      if (
        listResultBytes([...page, candidate], { queryHash: hash }) >
        (input.outputLimits?.maxToolOutputBytes ?? 256 * 1_024)
      ) {
        candidate = { ...item, value: compactListValue(item.value) }
      }
      if (
        listResultBytes([...page, candidate], { queryHash: hash }) >
        (input.outputLimits?.maxToolOutputBytes ?? 256 * 1_024)
      ) {
        if (page.length === 0) {
          throw new BackgroundTaskError(
            'BACKGROUND_PAGE_BUDGET_TOO_SMALL',
            'The configured Tool output limit cannot fit one background task',
          )
        }
        break
      }
      page.push(candidate)
    }
    const hasMore = combined.length > page.length || hasMoreAgents
    const last = page.at(-1)
    return json({
      tasks: page.map((item) => item.value),
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: encodeCursor({
              version: 1,
              queryHash: hash,
              createdAt: last.createdAt,
              id: last.id,
              type: last.type,
            }),
          }
        : {}),
    })
  }

  /** Cancels an owner-checked UI identity through the same execution services as model handles. */
  async cancelOwned(
    parentSessionId: SessionId,
    target: BackgroundTaskTarget,
  ): Promise<boolean> {
    if (target.kind === 'terminal') {
      this.#terminals.backgroundSnapshot(parentSessionId, target.terminalId)
      return this.#terminals.cancelBackground(
        parentSessionId,
        target.terminalId,
      )
    }
    const record = await this.#state.getExecution(
      parentSessionId,
      target.executionId,
    )
    if (!record || record.kind !== target.kind)
      throw new BackgroundTaskError(
        'BACKGROUND_TARGET_NOT_FOUND',
        'Background task was not found for this Session',
      )
    return (
      (target.kind === 'swarm'
        ? await this.#swarms.cancel?.(parentSessionId, target.executionId)
        : await this.#subagents.cancel?.(
            parentSessionId,
            target.executionId,
          )) ?? false
    )
  }

  /** Cancels one owned target and optionally waits for terminal convergence. */
  async cancel(input: BackgroundCancelInput): Promise<JsonValue> {
    await this.#snapshot(input, input.target, false)
    const cancellationRequested = await this.cancelOwned(
      input.parentSessionId,
      input.target.type === 'terminal'
        ? { kind: 'terminal', terminalId: terminalId(input.target.id) }
        : {
            kind: input.target.type,
            executionId: this.#resolveAgentTarget(
              input.parentSessionId,
              input.target,
            ),
          },
    )
    if (input.waitMs > 0) {
      const waited = await this.wait({
        ...input,
        targets: [input.target],
        mode: 'all',
        timeoutMs: input.waitMs,
      })
      return json({ cancellationRequested, wait: waited })
    }
    return json({
      cancellationRequested,
      target: await this.#snapshot(input, input.target, true),
    })
  }

  /** Cancels every Agent and Terminal task owned by one public Session. */
  async cancelSession(parentSessionId: SessionId): Promise<void> {
    let before:
      | {
          createdAt: string
          executionId: AgentExecutionId
        }
      | undefined
    const roots: SubagentExecutionRecord[] = []
    do {
      const page = await this.#state.listRoots({
        parentSessionId,
        before,
        limit: 100,
      })
      roots.push(
        ...page.records.filter((record) => !agentTerminal(record.status)),
      )
      before = page.nextBefore
      if (!page.hasMore) break
    } while (before)
    for (const root of roots) {
      if (root.kind === 'swarm') {
        await this.#swarms.cancel?.(parentSessionId, root.id)
      } else {
        await this.#subagents.cancel?.(parentSessionId, root.id)
      }
    }
    for (const terminal of this.#terminals.listBackground(parentSessionId)) {
      if (!terminalTerminal(terminal.status)) {
        this.#terminals.cancelBackground(parentSessionId, terminal.terminalId)
      }
    }
    const deadline = performance.now() + 60_000
    while (performance.now() < deadline) {
      const activeRoots = await Promise.all(
        roots.map((root) => this.#state.getExecution(parentSessionId, root.id)),
      )
      const agentsDone = activeRoots.every(
        (record) => !record || agentTerminal(record.status),
      )
      const terminalsDone = this.#terminals
        .listBackground(parentSessionId)
        .every((terminal) => terminalTerminal(terminal.status))
      if (agentsDone && terminalsDone) return
      await delay(POLL_INTERVAL_MS)
    }
    throw new BackgroundTaskError(
      'BACKGROUND_QUIESCE_TIMEOUT',
      'Background tasks did not converge within 60 seconds',
    )
  }

  async #snapshots(
    input: BackgroundRequestLike,
    includeResult: boolean,
  ): Promise<Array<Record<string, JsonValue>>> {
    return Promise.all(
      input.targets.map((target) =>
        this.#snapshot(input, target, includeResult),
      ),
    )
  }

  #attachTerminalWaitOutput(
    input: BackgroundWaitInput,
    snapshots: readonly Record<string, JsonValue>[],
  ): Array<Record<string, JsonValue>> {
    const maxBytes = input.outputLimits?.maxToolOutputBytes ?? 256 * 1_024
    return snapshots.map((snapshot) => {
      if (snapshot.type !== 'terminal' || typeof snapshot.id !== 'number') {
        return snapshot
      }
      const id = terminalId(snapshot.id)
      try {
        const output = this.#terminals.readBackground(
          input.parentSessionId,
          id,
          {
            lines: TERMINAL_BACKGROUND_TAIL_LINES,
            maxBytes,
          },
        )
        return {
          ...snapshot,
          content: output.content,
          cursor: output.cursor,
          tail: true,
          tailLines: TERMINAL_BACKGROUND_TAIL_LINES,
          truncated: output.truncated,
          totalBytes: output.totalBytes,
        }
      } catch {
        return {
          ...snapshot,
          content: '',
          outputUnavailable: true,
        }
      }
    })
  }

  async #snapshot(
    input: Pick<BackgroundWaitInput, 'parentSessionId' | 'sessionTemp'>,
    target: BackgroundTarget,
    includeResult: boolean,
  ): Promise<Record<string, JsonValue>> {
    if (target.type === 'terminal') {
      try {
        return this.#terminalSnapshotValue(
          this.#terminals.backgroundSnapshot(
            input.parentSessionId,
            terminalId(target.id),
          ),
        )
      } catch (error) {
        throw new BackgroundTaskError(
          'BACKGROUND_TARGET_NOT_FOUND',
          error instanceof Error ? error.message : 'Terminal was not found',
        )
      }
    }
    return this.#agentSnapshot(
      input.parentSessionId,
      input.sessionTemp,
      target,
      includeResult,
    )
  }

  async #agentSnapshot(
    parentSessionId: SessionId,
    sessionTemp: BackgroundWaitInput['sessionTemp'],
    target: BackgroundTarget,
    includeResult: boolean,
  ): Promise<Record<string, JsonValue>> {
    const executionId = this.#resolveAgentTarget(parentSessionId, target)
    const record = await this.#state.getExecution(parentSessionId, executionId)
    if (!record || record.kind !== target.type) {
      throw new BackgroundTaskError(
        'BACKGROUND_TARGET_NOT_FOUND',
        `${target.type} target was not found for this Session`,
      )
    }
    if (record.kind === 'swarm') {
      const manifestPath = path.join(
        sessionTemp.artifacts,
        'swarms',
        record.id,
        'manifest.json',
      )
      const liveArtifact = this.#swarms.artifactStatus?.(record.id)
      const available =
        liveArtifact?.artifactAvailable ?? (await this.#exists(manifestPath))
      const children = await this.#state.listChildren(
        parentSessionId,
        record.id,
      )
      return {
        type: 'swarm',
        id: target.id,
        name: record.name,
        status: record.status,
        terminal: agentTerminal(record.status),
        counts: json(await this.#state.executionCounts(record.id)),
        children: children.map((child) => ({
          target: {
            type: 'subagent' as const,
            id: this.#handles.expose({
              executionId: child.id,
              parentSessionId: child.parentSessionId,
              type: 'subagent',
            }),
          },
          ...(child.childOrdinal === undefined
            ? {}
            : { childOrdinal: child.childOrdinal }),
          name: child.name,
          status: child.status,
          terminal: agentTerminal(child.status),
          ...(boundedError(child.error)
            ? { error: boundedError(child.error) }
            : {}),
        })),
        artifactAvailable: available,
        ...(available
          ? { manifestPath: liveArtifact?.artifactPath ?? manifestPath }
          : {}),
        ...(!available
          ? {
              captureError:
                liveArtifact?.captureError ??
                'Swarm manifest is unavailable or expired',
            }
          : {}),
        ...(boundedError(record.error)
          ? { error: json(boundedError(record.error)) }
          : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }
    }
    const directory = path.join(sessionTemp.artifacts, 'subagents', record.id)
    const activityPath = path.join(directory, 'activity.jsonl')
    const resultPath = path.join(directory, 'result.md')
    const activityAvailable = await this.#exists(activityPath)
    const resultAvailable = await this.#exists(resultPath)
    const liveArtifact = this.#subagents.artifactStatus?.(record.id)
    const artifactAvailable =
      liveArtifact?.artifactAvailable ?? activityAvailable
    const response = includeResult ? this.#subagentResponse(record) : undefined
    const parent = record.parentExecutionId
      ? await this.#state.getExecution(
          parentSessionId,
          record.parentExecutionId,
        )
      : undefined
    return {
      type: 'subagent',
      id: target.id,
      name: record.name,
      status: record.status,
      terminal: agentTerminal(record.status),
      artifactAvailable,
      ...(artifactAvailable ? { activityPath } : {}),
      ...(resultAvailable ? { resultPath } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(parent?.kind === 'swarm'
        ? {
            parentTarget: {
              type: 'swarm',
              id: this.#handles.expose({
                executionId: parent.id,
                parentSessionId: parent.parentSessionId,
                type: 'swarm',
              }),
            },
          }
        : {}),
      ...(!artifactAvailable
        ? {
            captureError:
              liveArtifact?.captureError ??
              'Subagent activity artifact is unavailable or expired',
          }
        : {}),
      ...(boundedError(record.error)
        ? { error: json(boundedError(record.error)) }
        : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  #terminalSnapshotValue(
    terminal: TerminalBackgroundSnapshot,
  ): Record<string, JsonValue> {
    return {
      type: 'terminal',
      id: terminal.terminalId,
      terminalId: terminal.terminalId,
      status: terminal.status,
      terminal: terminalTerminal(terminal.status),
      exitCode: terminal.exitCode,
      cursor: terminal.cursor,
      artifactAvailable: terminal.artifactAvailable,
      ...(terminal.artifactPath ? { artifactPath: terminal.artifactPath } : {}),
      ...(terminal.captureError ? { captureError: terminal.captureError } : {}),
      createdAt: terminal.createdAt,
    }
  }

  #resolveAgentTarget(
    parentSessionId: SessionId,
    target: BackgroundTarget,
  ): AgentExecutionId {
    if (target.type === 'terminal') {
      throw new BackgroundTaskError(
        'BACKGROUND_TARGET_INVALID',
        'Terminal targets do not resolve to Agent executions',
      )
    }
    const executionId = this.#handles.resolve({
      id: target.id,
      parentSessionId,
      type: target.type,
    })
    if (!executionId) {
      throw new BackgroundTaskError(
        'BACKGROUND_TARGET_NOT_FOUND',
        `${target.type} target was not found for this Session or process`,
      )
    }
    return executionId
  }

  #subagentResponse(record: SubagentExecutionRecord): string | undefined {
    if (
      !record.result ||
      typeof record.result !== 'object' ||
      Array.isArray(record.result)
    ) {
      return undefined
    }
    const results = record.result.results
    if (!results || typeof results !== 'object' || Array.isArray(results)) {
      return undefined
    }
    return Object.values(results).find(
      (value): value is string => typeof value === 'string',
    )
  }

  #matchesStatus(
    status: AgentExecutionStatus,
    filter: BackgroundListInput['status'],
  ): boolean {
    return (
      filter === 'all' ||
      (filter === 'active' && !agentTerminal(status)) ||
      (filter === 'finished' && agentTerminal(status))
    )
  }

  async #exists(filePath: string): Promise<boolean> {
    return access(filePath).then(
      () => true,
      () => false,
    )
  }
}

type BackgroundRequestLike = Pick<
  BackgroundWaitInput,
  'parentSessionId' | 'sessionTemp' | 'targets'
>
