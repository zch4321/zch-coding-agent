import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { EventId } from '../../shared/ids'
import type {
  PromptBuildSummary,
  ProviderStats,
  ReplaySummary,
  TraceInfo,
} from '../../shared/trace'
import { useAgentStore } from './agent'

interface PromptRequestView {
  eventId: EventId
  runId: string
  seq: number
  messages: unknown[]
  promptBuild?: PromptBuildSummary
}

type ReplayView = Omit<ReplaySummary, 'requests'> & {
  requests: PromptRequestView[]
}

export const useTraceStore = defineStore('traces', {
  state: () => ({
    items: [] as TraceInfo[],
    selectedId: undefined as string | undefined,
    replay: undefined as ReplayView | undefined,
    providerStats: undefined as ProviderStats | undefined,
    forkEventId: '',
    promptRequestEventId: '',
    actionMessage: '',
    loading: false,
    error: '',
  }),
  getters: {
    options: (state) =>
      state.items.map((trace) => ({
        label:
          trace.traceId +
          ' · ' +
          (trace.closed ? 'closed' : 'active') +
          ' · ' +
          trace.eventCount +
          ' events',
        value: trace.traceId,
      })),
    forkPointOptions: (state) =>
      (state.replay?.forkPoints ?? []).map((point) => ({
        label: '#' + point.seq + ' · ' + point.runId + ' · ' + point.eventId,
        value: point.eventId,
      })),
    promptRequestOptions: (state) =>
      (state.replay?.requests ?? []).map((request) => ({
        label:
          '#' + request.seq + ' · ' + request.runId + ' · ' + request.eventId,
        value: request.eventId,
      })),
    selectedPromptRequest: (state): PromptRequestView | undefined =>
      (state.replay?.requests ?? []).find(
        (request) => request.eventId === state.promptRequestEventId,
      ),
  },
  actions: {
    async load() {
      const bridge = window.agentApi
      if (!bridge || this.loading) return
      this.loading = true
      this.actionMessage = ''
      this.error = ''
      try {
        const [list, stats] = await Promise.all([
          bridge.listTraces({ version: IPC_VERSION }),
          bridge.getTraceStats({ version: IPC_VERSION }),
        ])
        if (list.ok) {
          this.items = list.value
          if (
            this.selectedId &&
            !this.items.some((trace) => trace.traceId === this.selectedId)
          ) {
            this.selectedId = undefined
            this.replay = undefined
          }
        } else this.error = list.error.message
        if (stats.ok) this.providerStats = stats.value
        else this.error = stats.error.message
      } finally {
        this.loading = false
      }
    },
    async replaySelected() {
      const bridge = window.agentApi
      if (!bridge || !this.selectedId) return
      const result = await bridge.replayTrace({
        version: IPC_VERSION,
        traceId: this.selectedId,
      })
      if (result.ok) {
        this.replay = result.value as ReplayView
        this.promptRequestEventId = result.value.requests.at(-1)?.eventId ?? ''
        this.actionMessage =
          'Replayed ' +
          result.value.lastSeq +
          ' events without executing tools.'
      } else this.error = result.error.message
    },
    async forkSelected() {
      const bridge = window.agentApi
      const agent = useAgentStore()
      if (
        !bridge ||
        !this.selectedId ||
        !this.forkEventId.trim() ||
        !this.replay?.workspace
      ) {
        return
      }

      const prepared = await bridge.forkTrace({
        version: IPC_VERSION,
        traceId: this.selectedId,
        eventId: this.forkEventId.trim() as EventId,
      })
      if (!prepared.ok) {
        this.error = prepared.error.message
        return
      }

      agent.saveActiveConversation()
      await agent.activateWorkspace(this.replay.workspace)
      const conversation = agent.createConversation(this.replay.workspace)
      if (!conversation) {
        await bridge.closeSession({
          version: IPC_VERSION,
          sessionId: prepared.value.sessionId,
        })
        this.error = 'Unable to create a conversation for the trace fork'
        return
      }

      conversation.title = ('Fork ' + this.selectedId).slice(0, 120)
      agent.sessionIdsByConversation[conversation.id] = prepared.value.sessionId
      agent.sessionId = prepared.value.sessionId
      agent.runStatus = 'idle'
      agent.activeRunId = undefined
      const started = await bridge.startTraceFork({
        version: IPC_VERSION,
        sessionId: prepared.value.sessionId,
      })
      if (!started.ok) {
        await agent.closeRuntimeSession(conversation.id)
        this.error = started.error.message
        return
      }

      agent.activeRunId = started.value.runId
      this.actionMessage =
        'Fork started in conversation “' +
        conversation.title +
        '”. Historical tools were not replayed.'
      agent.persistWorkbench()
    },
    async openDirectory() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.openLogDirectory({ version: IPC_VERSION })
      if (!result.ok) this.error = result.error.message
    },
    async clearClosed() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.clearClosedTraces({ version: IPC_VERSION })
      if (result.ok) {
        this.actionMessage =
          'Deleted ' + result.value.deleted + ' closed trace(s).'
        await this.load()
      } else this.error = result.error.message
    },
  },
})
