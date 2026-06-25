import { defineStore } from 'pinia'
import type { RunId } from '../../shared/ids'
import type {
  ChatMessage,
  ConversationRecord,
  ReviewedApproval,
  ToolActivity,
  UsageActivity,
  ContextAttachmentChip,
  GoalState,
  PlanState,
} from './agent-types'
import { cloneMessages, requestId } from './workbench-persistence'

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const useAgentTimelineStore = defineStore('agent-timeline', {
  state: () => ({
    input: '',
    messages: [] as ChatMessage[],
    tools: [] as ToolActivity[],
    usage: [] as UsageActivity[],
    contextAttachments: [] as ContextAttachmentChip[],
    goal: undefined as GoalState | undefined,
    plan: undefined as PlanState | undefined,
    timelineCounter: 0,
    latestReviewedApproval: undefined as ReviewedApproval | undefined,
  }),
  getters: {
    latestUsage: (state) => state.usage.at(-1)?.usage,
    conversationTotalTokens: (state) =>
      state.usage.reduce(
        (total, item) =>
          total +
          (item.usage.totalTokens ??
            (item.usage.promptTokens ?? 0) +
              (item.usage.completionTokens ?? 0)),
        0,
      ),
  },
  actions: {
    reset() {
      this.input = ''
      this.messages = []
      this.tools = []
      this.usage = []
      this.contextAttachments = []
      this.goal = undefined
      this.plan = undefined
      this.timelineCounter = 0
      this.latestReviewedApproval = undefined
    },
    hydrate(conversation?: ConversationRecord) {
      this.messages = conversation ? cloneMessages(conversation.messages) : []
      this.tools = (conversation?.tools ?? []).map((tool) => ({ ...tool }))
      this.usage = (conversation?.usage ?? []).map((item) => ({ ...item }))
      this.contextAttachments = []
      this.goal = conversation?.goal ? cloneJson(conversation.goal) : undefined
      this.plan = conversation?.plan ? cloneJson(conversation.plan) : undefined
      this.latestReviewedApproval = conversation?.latestReviewedApproval
        ? { ...conversation.latestReviewedApproval }
        : undefined
      this.timelineCounter = Math.max(
        this.messages.reduce(
          (maximum, message) => Math.max(maximum, message.order ?? 0),
          0,
        ),
        this.tools.reduce(
          (maximum, tool) => Math.max(maximum, tool.order ?? 0),
          0,
        ),
        this.usage.reduce(
          (maximum, item) => Math.max(maximum, item.order ?? 0),
          0,
        ),
      )
    },
    writeToConversation(conversation: ConversationRecord) {
      conversation.messages = cloneMessages(this.messages)
      conversation.tools = this.tools.map((tool) => ({ ...tool }))
      conversation.usage = this.usage.map((item) => ({ ...item }))
      conversation.goal = this.goal ? cloneJson(this.goal) : undefined
      conversation.plan = this.plan ? cloneJson(this.plan) : undefined
      conversation.latestReviewedApproval = this.latestReviewedApproval
        ? { ...this.latestReviewedApproval }
        : undefined
    },
    assistantMessage(runId: RunId): ChatMessage {
      const latestToolOrder = this.tools.reduce(
        (maximum, tool) =>
          tool.runId === runId ? Math.max(maximum, tool.order ?? 0) : maximum,
        0,
      )
      let message = this.messages
        .filter((item) => item.role === 'assistant' && item.runId === runId)
        .sort((left, right) => (right.order ?? 0) - (left.order ?? 0))[0]

      if (!message || (message.order ?? 0) < latestToolOrder) {
        message = {
          id: requestId(),
          role: 'assistant',
          runId,
          text: '',
          reasoning: '',
          order: this.nextTimelineOrder(),
        }
        this.messages.push(message)
      }
      return message
    },
    nextTimelineOrder(): number {
      this.timelineCounter += 1
      return this.timelineCounter
    },
    addContextAttachments(attachments: ContextAttachmentChip[]) {
      const seen = new Set(
        this.contextAttachments.map((item) => `${item.kind}:${item.path}`),
      )

      for (const attachment of attachments) {
        const key = `${attachment.kind}:${attachment.path}`
        if (seen.has(key)) continue
        seen.add(key)
        this.contextAttachments.push({ ...attachment })
      }
    },
    removeContextAttachment(path: string, kind: ContextAttachmentChip['kind']) {
      this.contextAttachments = this.contextAttachments.filter(
        (item) => item.path !== path || item.kind !== kind,
      )
    },
    clearContextAttachments() {
      this.contextAttachments = []
    },
  },
})
