import type { ChatMessage, PersistedWorkbench } from './agent-types'

export const HISTORY_KEY = 'my-coding-agent.workbench.v1'

export function requestId(): string {
  return `ui:${
    'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}:${Math.random().toString(16).slice(2)}`
  }`
}

export function projectName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? workspacePath
}

export function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
  }))
}

export function loadWorkbench(): PersistedWorkbench {
  try {
    const value = window.localStorage.getItem(HISTORY_KEY)

    if (!value) {
      return { projects: [], conversations: [] }
    }

    const parsed = JSON.parse(value) as Partial<PersistedWorkbench>
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations
        : [],
      activeConversationId:
        typeof parsed.activeConversationId === 'string'
          ? parsed.activeConversationId
          : undefined,
    }
  } catch {
    return { projects: [], conversations: [] }
  }
}
