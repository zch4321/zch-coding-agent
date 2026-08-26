import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import type {
  AgentExecutionActivity,
  AgentExecutionDetail,
  AgentExecutionEvent,
  AgentExecutionListCursor,
  AgentExecutionLiveOverlay,
  AgentExecutionSummary,
} from '../../shared/agent-execution'
import type { ProviderRetryState } from '../../shared/agent-events'
import { IPC_VERSION } from '../../shared/channels'
import type { AgentExecutionId, SessionId } from '../../shared/ids'
import type { LlmUsageRecord } from '../../shared/usage'
import type { ActiveRunApprovalSnapshot } from '../../shared/runtime-state'
import { useAgentReplicaStore } from './agent-replica'

interface ExecutionSessionView {
  records: AgentExecutionSummary[]
  hasMore: boolean
  nextBefore?: AgentExecutionListCursor
  loaded: boolean
  loading: boolean
  error?: string
}

interface ExecutionDetailView {
  detail?: AgentExecutionDetail
  loaded: boolean
  loading: boolean
  error?: string
}

interface LiveExecutionView {
  lastEventSeq: number
  phase?: Extract<AgentExecutionEvent, { type: 'run.status' }>['status']
  generation: number
  text: string
  reasoning: string
  providerRetry?: ProviderRetryState
  approval?: ActiveRunApprovalSnapshot
  approvalSubmitting: boolean
  activities: AgentExecutionActivity[]
  usage: LlmUsageRecord[]
}

const ACTIVE_STATUSES = new Set<AgentExecutionSummary['status']>([
  'queued',
  'preparing',
  'running',
])

/** Reports whether one delegated execution is still active. */
export function isActiveAgentExecution(
  summary: AgentExecutionSummary,
): boolean {
  return ACTIVE_STATUSES.has(summary.status)
}

function blankSessionView(): ExecutionSessionView {
  return { records: [], hasMore: false, loaded: false, loading: false }
}

function blankLiveView(): LiveExecutionView {
  return {
    lastEventSeq: 0,
    generation: 0,
    text: '',
    reasoning: '',
    activities: [],
    usage: [],
    approvalSubmitting: false,
  }
}

function activityKey(activity: AgentExecutionActivity): string {
  return activity.type === 'tool'
    ? `tool:${activity.callId}`
    : `${activity.type}:${activity.id}`
}

function activityMatches(
  durable: AgentExecutionActivity,
  live: AgentExecutionActivity,
): boolean {
  if (activityKey(durable) === activityKey(live)) return true
  return (
    durable.type !== 'tool' &&
    live.type === durable.type &&
    live.text === durable.text
  )
}

function cloneReactiveSafe<T>(value: T): T {
  return structuredClone(toRaw(value))
}

function mergeToolActivity(
  left: Extract<AgentExecutionActivity, { type: 'tool' }>,
  right: Extract<AgentExecutionActivity, { type: 'tool' }>,
): Extract<AgentExecutionActivity, { type: 'tool' }> {
  const earlier =
    left.seq < right.seq ||
    (left.seq === right.seq && left.ordinal <= right.ordinal)
      ? left
      : right
  const later = earlier === left ? right : left
  const args =
    typeof earlier.args === 'object' &&
    earlier.args !== null &&
    !Array.isArray(earlier.args) &&
    Object.keys(earlier.args).length === 0
      ? later.args
      : earlier.args
  return {
    ...earlier,
    tool: earlier.tool === 'unknown' ? later.tool : earlier.tool,
    args: cloneReactiveSafe(args),
    reason: later.reason || earlier.reason,
    status:
      left.status === 'completed' || right.status === 'completed'
        ? 'completed'
        : 'proposed',
    ...(right.result !== undefined
      ? { result: cloneReactiveSafe(right.result) }
      : left.result !== undefined
        ? { result: cloneReactiveSafe(left.result) }
        : {}),
  }
}

function mergeActivities(
  current: readonly AgentExecutionActivity[],
  incoming: readonly AgentExecutionActivity[],
): AgentExecutionActivity[] {
  const merged = new Map<string, AgentExecutionActivity>()
  for (const activity of [...current, ...incoming]) {
    const key = activityKey(activity)
    const existing = merged.get(key)
    merged.set(
      key,
      existing?.type === 'tool' && activity.type === 'tool'
        ? mergeToolActivity(existing, activity)
        : cloneReactiveSafe(activity),
    )
  }
  return [...merged.values()].sort(
    (left, right) => left.seq - right.seq || left.ordinal - right.ordinal,
  )
}

function summarizedUsage(records: readonly LlmUsageRecord[]) {
  const sum = (field: keyof LlmUsageRecord): number =>
    records.reduce((total, record) => {
      const value = record[field]
      return total + (typeof value === 'number' ? value : 0)
    }, 0)
  return {
    records: records.length,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    cacheHitTokens: sum('cacheHitTokens'),
    cacheMissTokens: sum('cacheMissTokens'),
  }
}

/** Owns parent-scoped execution summaries, durable details, and live overlays. */
export const useAgentExecutionStore = defineStore('agent-executions', {
  state: () => ({
    sessions: {} as Record<string, ExecutionSessionView>,
    children: {} as Record<string, AgentExecutionSummary[]>,
    details: {} as Record<string, ExecutionDetailView>,
    live: {} as Record<string, LiveExecutionView>,
  }),
  getters: {
    selectedExecutions(state): AgentExecutionSummary[] {
      const sessionId = useAgentReplicaStore().selectedSessionId
      const records = sessionId
        ? (state.sessions[sessionId]?.records ?? [])
        : []
      return [...records].sort((left, right) => {
        const active =
          Number(isActiveAgentExecution(right)) -
          Number(isActiveAgentExecution(left))
        return (
          active ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id)
        )
      })
    },
    selectedActiveCount(state): number {
      return this.selectedExecutions.reduce((total, summary) => {
        if (summary.kind !== 'swarm') {
          return total + Number(isActiveAgentExecution(summary))
        }
        const children = state.children[summary.id]
        if (children?.length) {
          return total + children.filter(isActiveAgentExecution).length
        }
        return (
          total +
          (summary.agentCounts?.queued ?? 0) +
          (summary.agentCounts?.running ?? 0)
        )
      }, 0)
    },
    selectedSessionView(state): ExecutionSessionView | undefined {
      const sessionId = useAgentReplicaStore().selectedSessionId
      return sessionId ? state.sessions[sessionId] : undefined
    },
    childrenFor:
      (state) =>
      (executionId: AgentExecutionId): AgentExecutionSummary[] =>
        state.children[executionId] ?? [],
    activitiesFor:
      (state) =>
      (executionId: AgentExecutionId): AgentExecutionActivity[] => {
        const durable =
          state.details[executionId]?.detail?.activityPage.records ?? []
        const live = state.live[executionId]
        if (!live) return durable
        const streaming: AgentExecutionActivity[] = []
        if (live.reasoning.trim()) {
          streaming.push({
            type: 'reasoning',
            id: `stream:${executionId}:${live.generation}:reasoning`,
            seq: Number.MAX_SAFE_INTEGER,
            ordinal: live.lastEventSeq * 3,
            text: live.reasoning,
          })
        }
        if (live.text.trim()) {
          streaming.push({
            type: 'message',
            id: `stream:${executionId}:${live.generation}:message`,
            seq: Number.MAX_SAFE_INTEGER,
            ordinal: live.lastEventSeq * 3 + 1,
            text: live.text,
          })
        }
        return mergeActivities(durable, [...live.activities, ...streaming])
      },
  },
  actions: {
    ensureSession(sessionId: SessionId): ExecutionSessionView {
      if (!this.sessions[sessionId]) {
        this.sessions[sessionId] = blankSessionView()
      }
      return this.sessions[sessionId]!
    },
    ensureLive(executionId: AgentExecutionId): LiveExecutionView {
      if (!this.live[executionId]) {
        this.live[executionId] = blankLiveView()
      }
      return this.live[executionId]!
    },
    upsertSummary(summary: AgentExecutionSummary): void {
      if (summary.parentExecutionId) {
        const records = this.children[summary.parentExecutionId] ?? []
        this.children[summary.parentExecutionId] = mergeSummaries(records, [
          summary,
        ])
        const parentDetail = this.details[summary.parentExecutionId]?.detail
        if (parentDetail) {
          parentDetail.children = mergeSummaries(parentDetail.children ?? [], [
            summary,
          ])
        }
        const detail = this.details[summary.id]?.detail
        if (detail) detail.summary = structuredClone(summary)
        return
      }
      const session = this.ensureSession(summary.parentSessionId)
      const index = session.records.findIndex(
        (record) => record.id === summary.id,
      )
      if (index >= 0) session.records[index] = structuredClone(summary)
      else session.records.push(structuredClone(summary))
      const detail = this.details[summary.id]?.detail
      if (detail) detail.summary = structuredClone(summary)
    },
    removeSession(sessionId: SessionId): void {
      const executionIds = new Set<AgentExecutionId>()
      for (const summary of this.sessions[sessionId]?.records ?? []) {
        executionIds.add(summary.id)
        for (const child of this.children[summary.id] ?? []) {
          executionIds.add(child.id)
        }
      }
      for (const [executionId, detail] of Object.entries(this.details)) {
        if (detail.detail?.summary.parentSessionId === sessionId) {
          executionIds.add(executionId as AgentExecutionId)
        }
      }
      for (const executionId of executionIds) {
        delete this.details[executionId]
        delete this.live[executionId]
        delete this.children[executionId]
      }
      delete this.sessions[sessionId]
    },
    async loadSession(
      sessionId: SessionId,
      options: { append?: boolean; force?: boolean } = {},
    ): Promise<boolean> {
      const api = window.agentApi
      if (!api) return false
      const view = this.ensureSession(sessionId)
      if (view.loading || (!options.append && view.loaded && !options.force)) {
        return view.loaded
      }
      if (options.append && !view.hasMore) return true
      view.loading = true
      view.error = undefined
      const result = await api
        .listAgentExecutions({
          version: IPC_VERSION,
          parentSessionId: sessionId,
          ...(options.append && view.nextBefore
            ? { before: view.nextBefore }
            : {}),
          limit: 50,
        })
        .finally(() => {
          view.loading = false
        })
      if (!result.ok) {
        view.error = result.error.message
        return false
      }
      view.records = options.append
        ? mergeSummaries(view.records, result.value.page.records)
        : structuredClone(result.value.page.records)
      view.hasMore = result.value.page.hasMore
      view.nextBefore = result.value.page.nextBefore
        ? structuredClone(result.value.page.nextBefore)
        : undefined
      view.loaded = true
      return true
    },
    async loadDetail(
      executionId: AgentExecutionId,
      options: {
        older?: boolean
        refresh?: boolean
        parentSessionId?: SessionId
      } = {},
    ): Promise<boolean> {
      const api = window.agentApi
      if (!api) return false
      const summary = findSummary(this.sessions, this.children, executionId)
      const parentSessionId =
        summary?.parentSessionId ?? options.parentSessionId
      if (!parentSessionId) return false
      if (!this.details[executionId]) {
        this.details[executionId] = {
          loaded: false,
          loading: false,
        }
      }
      const view = this.details[executionId]!
      if (view.loading) {
        await waitForDetailLoad(view)
        return options.older || options.refresh
          ? this.loadDetail(executionId, options)
          : view.loaded
      }
      if (!options.older && !options.refresh && view.loaded) return true
      if (options.older && !view.detail?.activityPage.hasMore) return true
      view.loading = true
      view.error = undefined
      const eventSeqBeforeRequest = this.live[executionId]?.lastEventSeq ?? 0
      const result = await api
        .getAgentExecution({
          version: IPC_VERSION,
          parentSessionId,
          executionId,
          ...(options.older && view.detail?.activityPage.nextBeforeSeq
            ? { beforeSeq: view.detail.activityPage.nextBeforeSeq }
            : {}),
          limit: 100,
        })
        .finally(() => {
          view.loading = false
        })
      if (!result.ok) {
        view.error = result.error.message
        return false
      }
      const incoming = result.value.detail
      if (view.detail && (options.older || options.refresh)) {
        const existingPage = view.detail.activityPage
        incoming.activityPage.records = mergeActivities(
          existingPage.records,
          incoming.activityPage.records,
        )
        if (options.refresh && existingPage.hasMore) {
          incoming.activityPage.hasMore = existingPage.hasMore
          incoming.activityPage.nextBeforeSeq = existingPage.nextBeforeSeq
        }
      }
      view.detail = structuredClone(incoming)
      view.loaded = true
      this.upsertSummary(incoming.summary)
      if (incoming.children) {
        this.children[incoming.summary.id] = mergeSummaries(
          this.children[incoming.summary.id] ?? [],
          incoming.children,
        )
        for (const child of incoming.children) this.upsertSummary(child)
      }
      this.reconcileLiveActivities(executionId)
      if (
        incoming.live &&
        (this.live[executionId]?.lastEventSeq ?? 0) === eventSeqBeforeRequest
      ) {
        this.applyLiveOverlay(executionId, incoming.live)
      }
      if (!isActiveAgentExecution(incoming.summary) && !options.older) {
        const live = this.live[executionId]
        if (live) {
          live.activities = []
          live.text = ''
          live.reasoning = ''
        }
      }
      return true
    },
    async refreshBoundary(executionId: AgentExecutionId): Promise<void> {
      await this.loadDetail(executionId, { refresh: true })
    },
    reconcileLiveActivities(executionId: AgentExecutionId): void {
      const live = this.live[executionId]
      if (!live) return
      const durable =
        this.details[executionId]?.detail?.activityPage.records ?? []
      live.activities = live.activities.filter(
        (activity) =>
          !durable.some((record) => activityMatches(record, activity)),
      )
    },
    applyLiveOverlay(
      executionId: AgentExecutionId,
      overlay: AgentExecutionLiveOverlay,
    ): void {
      const live = this.ensureLive(executionId)
      const durable =
        this.details[executionId]?.detail?.activityPage.records ?? []
      live.phase = overlay.status
      live.providerRetry = overlay.providerRetry
        ? cloneReactiveSafe(overlay.providerRetry)
        : undefined
      live.approval = overlay.approval
        ? cloneReactiveSafe(overlay.approval)
        : undefined
      live.text = durable.some(
        (activity) =>
          activity.type === 'message' && activity.text === overlay.text,
      )
        ? ''
        : overlay.text
      live.reasoning = durable.some(
        (activity) =>
          activity.type === 'reasoning' && activity.text === overlay.reasoning,
      )
        ? ''
        : overlay.reasoning
      live.activities = mergeActivities(
        live.activities,
        overlay.tools.map((tool, index) => ({
          type: 'tool' as const,
          id: tool.callId,
          seq: Number.MAX_SAFE_INTEGER,
          ordinal: index * 3 + 2,
          callId: tool.callId,
          tool: tool.tool,
          args: cloneReactiveSafe(tool.args),
          reason: tool.reason,
          status: tool.status,
          ...(tool.result ? { result: cloneReactiveSafe(tool.result) } : {}),
        })),
      )
    },
    async resyncExecution(
      parentSessionId: SessionId,
      executionId: AgentExecutionId,
    ): Promise<void> {
      await this.loadSession(parentSessionId, { force: true })
      await this.loadDetail(executionId, { refresh: true, parentSessionId })
    },
    handleEvent(event: AgentExecutionEvent): void {
      const live = this.ensureLive(event.executionId)
      if (event.seq <= live.lastEventSeq) return
      if (event.seq !== live.lastEventSeq + 1) {
        void this.resyncExecution(event.parentSessionId, event.executionId)
      }
      live.lastEventSeq = event.seq
      if (event.type === 'execution.changed') {
        this.upsertSummary(event.summary)
        if (!isActiveAgentExecution(event.summary)) {
          const detail = this.details[event.executionId]
          if (detail) void this.refreshBoundary(event.executionId)
          live.text = ''
          live.reasoning = ''
          live.providerRetry = undefined
          live.approval = undefined
        }
        return
      }
      if (event.type === 'run.status') {
        const enteredProvider =
          event.status === 'calling_llm' && live.phase !== 'calling_llm'
        live.phase = event.status
        live.providerRetry = undefined
        if (event.status !== 'awaiting_approval') live.approval = undefined
        if (enteredProvider) {
          live.generation += 1
          live.text = ''
          live.reasoning = ''
          if (live.activities.length > 0) {
            void this.refreshBoundary(event.executionId)
          }
        }
        return
      }
      if (event.type === 'assistant.activity') {
        live.providerRetry = undefined
      } else if (event.type === 'assistant.stream.reset') {
        live.text = ''
        live.reasoning = ''
      } else if (event.type === 'provider.retrying') {
        live.providerRetry = cloneReactiveSafe(event.retry)
      } else if (event.type === 'assistant.text.delta') {
        live.providerRetry = undefined
        live.text += event.delta
      } else if (event.type === 'assistant.reasoning.delta') {
        live.providerRetry = undefined
        live.reasoning += event.delta
      } else if (event.type === 'assistant.message.completed') {
        live.providerRetry = undefined
        const activities: AgentExecutionActivity[] = []
        const order = event.seq * 3
        const reasoning = event.reasoning ?? live.reasoning
        if (reasoning.trim()) {
          activities.push({
            type: 'reasoning',
            id: `live:${event.executionId}:${live.generation}:reasoning`,
            seq: Number.MAX_SAFE_INTEGER,
            ordinal: order,
            text: reasoning,
          })
        }
        if (event.text.trim()) {
          activities.push({
            type: 'message',
            id: `live:${event.executionId}:${live.generation}:message`,
            seq: Number.MAX_SAFE_INTEGER,
            ordinal: order + 1,
            text: event.text,
          })
        }
        live.activities = mergeActivities(live.activities, activities)
        live.text = ''
        live.reasoning = ''
      } else if (event.type === 'tool.proposed') {
        live.activities = mergeActivities(live.activities, [
          {
            type: 'tool',
            id: event.callId,
            seq: Number.MAX_SAFE_INTEGER,
            ordinal: event.seq * 3 + 2,
            callId: event.callId,
            tool: event.tool,
            args: structuredClone(event.args),
            reason: event.reason,
            status: 'proposed',
          },
        ])
      } else if (event.type === 'approval.requested') {
        live.approval = cloneReactiveSafe(event.approval)
      } else if (event.type === 'tool.completed') {
        if (live.approval?.callId === event.callId) {
          live.approval = undefined
        }
        const existing = live.activities.find(
          (activity) =>
            activity.type === 'tool' && activity.callId === event.callId,
        )
        live.activities = mergeActivities(live.activities, [
          {
            type: 'tool',
            id: event.callId,
            seq: existing?.seq ?? Number.MAX_SAFE_INTEGER,
            ordinal: existing?.ordinal ?? event.seq * 3 + 2,
            callId: event.callId,
            tool: existing?.type === 'tool' ? existing.tool : 'unknown',
            args: existing?.type === 'tool' ? existing.args : {},
            reason: existing?.type === 'tool' ? existing.reason : '',
            status: 'completed',
            result: structuredClone(event.result),
          },
        ])
      } else if (event.type === 'llm.usage') {
        live.usage.push(structuredClone(event.usage))
        const summary = findSummary(
          this.sessions,
          this.children,
          event.executionId,
        )
        if (summary) summary.usage = summarizedUsage(live.usage)
      }
    },
    async decideApproval(
      executionId: AgentExecutionId,
      decision: 'allow' | 'deny',
    ): Promise<boolean> {
      const api = window.agentApi
      const live = this.ensureLive(executionId)
      const approval = live.approval
      const summary = findSummary(this.sessions, this.children, executionId)
      if (!api || !approval || !summary || live.approvalSubmitting) {
        return false
      }
      live.approvalSubmitting = true
      try {
        const result = await api.decideAgentExecutionApproval({
          version: IPC_VERSION,
          parentSessionId: summary.parentSessionId,
          executionId,
          callId: approval.callId,
          decision,
        })
        if (!result.ok || !result.value.accepted) return false
        live.approval = undefined
        return true
      } finally {
        live.approvalSubmitting = false
      }
    },
  },
})

function mergeSummaries(
  current: readonly AgentExecutionSummary[],
  incoming: readonly AgentExecutionSummary[],
): AgentExecutionSummary[] {
  const records = new Map(current.map((summary) => [summary.id, summary]))
  for (const summary of incoming) {
    const currentSummary = records.get(summary.id)
    if (
      !currentSummary ||
      summary.updatedAt.localeCompare(currentSummary.updatedAt) >= 0
    ) {
      records.set(summary.id, structuredClone(summary))
    }
  }
  return [...records.values()].sort((left, right) => {
    if (
      !left.parentExecutionId ||
      left.parentExecutionId !== right.parentExecutionId
    ) {
      return 0
    }
    return (
      (left.childOrdinal ?? Number.MAX_SAFE_INTEGER) -
        (right.childOrdinal ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    )
  })
}

function findSummary(
  sessions: Record<string, ExecutionSessionView>,
  children: Record<string, AgentExecutionSummary[]>,
  executionId: AgentExecutionId,
): AgentExecutionSummary | undefined {
  for (const session of Object.values(sessions)) {
    const summary = session.records.find((record) => record.id === executionId)
    if (summary) return summary
  }
  for (const records of Object.values(children)) {
    const summary = records.find((record) => record.id === executionId)
    if (summary) return summary
  }
  return undefined
}

function waitForDetailLoad(view: ExecutionDetailView): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!view.loading) {
        resolve()
        return
      }
      window.setTimeout(check, 0)
    }
    check()
  })
}
