import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { EventId } from '../../shared/ids'
import type {
  PromptBuildSummary,
  ProviderStats,
  ReplaySummary,
  TraceInfo,
} from '../../shared/trace'

interface PromptRequestView {
  eventId: EventId
  runId: string
  seq: number
  messages: unknown[]
  promptBuild?: PromptBuildSummary
}

interface TranscriptRequestView {
  messages: unknown[]
  total: number
  nextCursor?: string
  loading: boolean
}

export interface TranscriptEntryView {
  id: string
  seq: number
  ts: string
  kind: string
  categories: string[]
  title: string
  runId?: string
  callId?: string
  requestEventId?: string
  text?: string
  data?: unknown
  partial?: boolean
}

interface TranscriptMetadataView {
  traceId: string
  revision: string
  sessionId?: string
  conversationId?: string
  workspace?: string
  model?: string
  mode?: string
  lastSeq: number
  active: boolean
}

interface TranscriptPageView {
  metadata: TranscriptMetadataView
  total: number
  entries: TranscriptEntryView[]
  nextCursor?: string
}

interface TranscriptRequestMessagesPageView {
  total: number
  messages: unknown[]
  nextCursor?: string
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
    promptRequestEventId: '',
    actionMessage: '',
    loading: false,
    error: '',
    transcriptOpen: false,
    transcriptTraceId: undefined as string | undefined,
    transcriptMetadata: undefined as TranscriptMetadataView | undefined,
    transcriptEntries: [] as TranscriptEntryView[],
    transcriptTotal: 0,
    transcriptNextCursor: undefined as string | undefined,
    transcriptRequests: {} as Record<string, TranscriptRequestView>,
    transcriptLoading: false,
    transcriptError: '',
    transcriptUnavailable: false,
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
    async openTranscript(traceId: string) {
      this.transcriptOpen = true
      this.transcriptTraceId = traceId
      this.transcriptUnavailable = false
      await this.loadTranscript(true)
    },
    async openConversationTranscript(conversationId: string) {
      await this.load()
      const trace = this.items.find(
        (candidate) => candidate.conversationId === conversationId,
      )
      if (!trace) {
        this.transcriptOpen = true
        this.transcriptTraceId = undefined
        this.transcriptMetadata = undefined
        this.transcriptEntries = []
        this.transcriptUnavailable = true
        return
      }
      await this.openTranscript(trace.traceId)
    },
    closeTranscript() {
      this.transcriptOpen = false
    },
    async loadTranscript(reset = false) {
      const bridge = window.agentApi
      if (!bridge || !this.transcriptTraceId || this.transcriptLoading) return
      this.transcriptLoading = true
      this.transcriptError = ''
      try {
        const result = await bridge.getSessionTranscriptPage({
          version: IPC_VERSION,
          traceId: this.transcriptTraceId,
          ...(reset || !this.transcriptNextCursor
            ? {}
            : { cursor: this.transcriptNextCursor }),
          limit: 50,
        })
        if (!result.ok) {
          this.transcriptError = result.error.message
          return
        }
        const page = result.value as unknown as TranscriptPageView
        this.transcriptMetadata = page.metadata
        this.transcriptTotal = page.total
        this.transcriptNextCursor = page.nextCursor
        const combined: unknown[] = reset
          ? []
          : (this.transcriptEntries as unknown[])
        combined.push(...(page.entries as unknown[]))
        this.transcriptEntries = combined as TranscriptEntryView[]
        if (reset) this.transcriptRequests = {}
      } finally {
        this.transcriptLoading = false
      }
    },
    async loadTranscriptRequest(requestEventId: string, reset = false) {
      const bridge = window.agentApi
      if (!bridge || !this.transcriptTraceId) return
      const current = this.transcriptRequests[requestEventId]
      if (current?.loading || (!reset && current && !current.nextCursor)) return
      this.transcriptRequests[requestEventId] = {
        messages: reset ? [] : (current?.messages ?? []),
        total: reset ? 0 : (current?.total ?? 0),
        nextCursor: reset ? undefined : current?.nextCursor,
        loading: true,
      }
      const request = this.transcriptRequests[requestEventId]
      const result = await bridge.getSessionTranscriptRequestMessages({
        version: IPC_VERSION,
        traceId: this.transcriptTraceId,
        requestEventId: requestEventId as EventId,
        ...(request.nextCursor ? { cursor: request.nextCursor } : {}),
        limit: 10,
      })
      if (!result.ok) {
        request.loading = false
        this.transcriptError = result.error.message
        return
      }
      const page = result.value as unknown as TranscriptRequestMessagesPageView
      request.messages.push(...page.messages)
      request.total = page.total
      request.nextCursor = page.nextCursor
      request.loading = false
    },
    async exportTranscript() {
      const bridge = window.agentApi
      if (!bridge || !this.transcriptTraceId) return
      const result = await bridge.exportSessionTranscript({
        version: IPC_VERSION,
        traceId: this.transcriptTraceId,
      })
      if (!result.ok) this.transcriptError = result.error.message
      else if (!result.value.canceled && result.value.path) {
        this.actionMessage = 'Exported transcript to ' + result.value.path
      }
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
