import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PermissionMode } from '../../shared/config'
import {
  conversationToMarkdown,
  markdownToConversation,
  ConversationMarkdownError,
} from '../../shared/conversation-markdown'
import {
  CONVERSATION_TITLE_MAX,
  DEFAULT_CONVERSATION_TITLE,
  FORK_TITLE_PREFIX,
  deriveAutoTitle,
  normalizeTitle,
} from '../../shared/conversation-titles'
import type {
  ConversationRecord,
  PersistedWorkbench,
  ProjectRecord,
} from './agent-types'
import {
  HISTORY_KEY,
  cloneMessages,
  loadWorkbench,
  projectName,
  requestId,
} from './workbench-persistence'

let workspaceActivationQueue = Promise.resolve()
const MIGRATED_HISTORY_KEY = 'zch-coding-agent.workbench.v2.migrated'
type WorkbenchIpcResult =
  | { ok: true; value: PersistedWorkbench }
  | { ok: false; error: { message: string } }
type WorkbenchBridge = {
  getWorkbench(payload: {
    version: typeof IPC_VERSION
  }): Promise<WorkbenchIpcResult>
  migrateWorkbenchV1(payload: {
    version: typeof IPC_VERSION
    workbench: unknown
  }): Promise<WorkbenchIpcResult>
  saveWorkbench(payload: {
    version: typeof IPC_VERSION
    workbench: unknown
  }): Promise<WorkbenchIpcResult>
}

function hasConversationContent(conversation: ConversationRecord): boolean {
  return Boolean(
    conversation.messages.length > 0 ||
    (conversation.tools?.length ?? 0) > 0 ||
    (conversation.orchestratorEntries?.length ?? 0) > 0,
  )
}

function persistableConversation(
  conversation: ConversationRecord,
): Omit<ConversationRecord, 'transient'> | undefined {
  if (conversation.transient && !hasConversationContent(conversation)) {
    return undefined
  }

  const persistable = { ...conversation }
  delete persistable.transient
  return persistable
}

function cloneForIpc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshotForPersistence(state: {
  projects: ProjectRecord[]
  conversations: ConversationRecord[]
  activeConversationId?: string
}): PersistedWorkbench {
  const conversations = state.conversations
    .map(persistableConversation)
    .filter((conversation) => conversation !== undefined)
  const activeConversationId = conversations.some(
    (conversation) => conversation.id === state.activeConversationId,
  )
    ? state.activeConversationId
    : undefined

  return cloneForIpc({
    projects: state.projects,
    conversations,
    ...(activeConversationId ? { activeConversationId } : {}),
  })
}

export const useAgentWorkbenchStore = defineStore('agent-workbench', {
  state: () => ({
    error: '',
    workspacePath: '',
    projects: [] as ProjectRecord[],
    conversations: [] as ConversationRecord[],
    activeConversationId: undefined as string | undefined,
  }),
  getters: {
    activeConversation(): ConversationRecord | undefined {
      const conversations = this.conversations as ConversationRecord[]
      const activeConversationId = this.activeConversationId as
        | string
        | undefined
      return conversations.find(
        (conversation) => conversation.id === activeConversationId,
      )
    },
  },
  actions: {
    async loadPersistedWorkbench() {
      const history = loadWorkbench()
      const bridge = window.agentApi as unknown as WorkbenchBridge | undefined

      if (!bridge?.getWorkbench || !bridge.migrateWorkbenchV1) {
        this.projects = history.projects
        this.conversations = history.conversations
        this.activeConversationId = history.activeConversationId
        return
      }

      const shouldMigrate =
        !window.localStorage.getItem(MIGRATED_HISTORY_KEY) &&
        (history.projects.length > 0 || history.conversations.length > 0)
      const result = shouldMigrate
        ? await bridge.migrateWorkbenchV1({
            version: IPC_VERSION,
            workbench: history,
          })
        : await bridge.getWorkbench({
            version: IPC_VERSION,
          })

      if (!result.ok) {
        this.error = result.error.message
        this.projects = history.projects
        this.conversations = history.conversations
        this.activeConversationId = history.activeConversationId
        return
      }

      if (shouldMigrate) {
        window.localStorage.setItem(MIGRATED_HISTORY_KEY, 'true')
        window.localStorage.removeItem(HISTORY_KEY)
      }

      this.projects = result.value.projects
      this.conversations = result.value.conversations
      this.activeConversationId = result.value.activeConversationId
    },
    registerProject(workspacePath: string) {
      if (!this.projects.some((project) => project.path === workspacePath)) {
        this.projects.push({
          path: workspacePath,
          name: projectName(workspacePath),
          addedAt: new Date().toISOString(),
        })
      }
    },
    createConversationRecord(
      workspacePath: string,
      model: string,
      mode: PermissionMode,
    ) {
      const now = new Date().toISOString()
      const conversation: ConversationRecord = {
        id: requestId(),
        projectPath: workspacePath,
        title: DEFAULT_CONVERSATION_TITLE,
        model,
        mode,
        messages: [],
        tools: [],
        createdAt: now,
        updatedAt: now,
        transient: true,
      }
      this.registerProject(workspacePath)
      this.conversations.push(conversation)
      this.activeConversationId = conversation.id
      return conversation
    },
    renameConversation(conversationId: string, title: string) {
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )
      const normalized = normalizeTitle(title)
      if (!conversation || !normalized) return
      conversation.title = normalized
      conversation.updatedAt = new Date().toISOString()
      this.persistWorkbench()
    },
    applyAutoTitle(conversation: ConversationRecord, text: string) {
      if (conversation.title !== DEFAULT_CONVERSATION_TITLE) return
      conversation.title = deriveAutoTitle(text)
    },
    /**
     * Copy a conversation (optionally truncated at forkPointMessageId) into a
     * new conversation that records fork metadata. The original conversation
     * is never mutated, per road-map R6 ("回退对话：默认创建新分支，不直接破坏
     * 原历史"). Tool/usage/goal/plan state is copied so the branch can continue
     * a run; orchestrator entries are copied too.
     */
    forkConversation(
      sourceId: string,
      forkPointMessageId?: string,
      title?: string,
    ): ConversationRecord | undefined {
      const source = this.conversations.find((item) => item.id === sourceId)
      if (!source) return undefined

      const messages = cloneMessages(source.messages)
      let truncated = messages
      if (forkPointMessageId) {
        const cutIndex = messages.findIndex(
          (message) => message.id === forkPointMessageId,
        )
        if (cutIndex >= 0) {
          truncated = messages.slice(0, cutIndex + 1)
        }
      }

      const now = new Date().toISOString()
      const forked: ConversationRecord = {
        id: requestId(),
        projectPath: source.projectPath,
        title: normalizeTitle(title ?? `${FORK_TITLE_PREFIX}: ${source.title}`),
        model: source.model,
        mode: source.mode,
        messages: truncated,
        tools: source.tools?.map((tool) => ({ ...tool })),
        usage: source.usage?.map((item) => ({ ...item })),
        goal: source.goal ? structuredClone(source.goal) : undefined,
        plan: source.plan ? structuredClone(source.plan) : undefined,
        orchestratorEntries: source.orchestratorEntries?.map((entry) => ({
          ...entry,
        })),
        latestReviewedApproval: source.latestReviewedApproval
          ? { ...source.latestReviewedApproval }
          : undefined,
        parentId: source.id,
        parentTitle: source.title,
        forkPointMessageId: forkPointMessageId,
        forkedAt: now,
        createdAt: now,
        updatedAt: now,
      }
      this.conversations.push(forked)
      this.activeConversationId = forked.id
      this.persistWorkbench()
      return forked
    },
    /**
     * Revert (回退对话) the active conversation to the state at a message by
     * creating a new branch truncated at that message. Mirrors forkConversation
     * but always truncates and defaults the title to indicate a revert.
     */
    revertConversationToMessage(
      sourceId: string,
      forkPointMessageId: string,
    ): ConversationRecord | undefined {
      const source = this.conversations.find((item) => item.id === sourceId)
      if (!source) return undefined
      return this.forkConversation(
        sourceId,
        forkPointMessageId,
        `Revert: ${source.title}`,
      )
    },
    /**
     * Build a markdown export string for a conversation.
     */
    exportConversationMarkdown(conversationId: string): string | undefined {
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )
      if (!conversation) return undefined
      // The renderer ConversationRecord is structurally compatible with the
      // shared record; cast to satisfy the shared conversion module.
      return conversationToMarkdown(
        conversation as unknown as Parameters<typeof conversationToMarkdown>[0],
      )
    },
    async exportConversationViaDialog(
      conversationId: string,
    ): Promise<{ canceled: boolean; path?: string; error?: string }> {
      const bridge = window.agentApi
      const markdown = this.exportConversationMarkdown(conversationId)
      if (!markdown || !bridge?.exportConversationMarkdown) {
        return { canceled: true }
      }
      const conversation = this.conversations.find(
        (item) => item.id === conversationId,
      )
      const safeTitle = (conversation?.title ?? 'conversation')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 80)
      const result = await bridge.exportConversationMarkdown({
        version: IPC_VERSION,
        markdown,
        suggestedName: `${safeTitle}.md`,
      })
      if (!result.ok) return { canceled: true, error: result.error.message }
      return {
        canceled: result.value.canceled,
        path: result.value.path,
      }
    },
    /**
     * Import a conversation from markdown via a file dialog. Per the user's
     * direction, import never overwrites an existing conversation: a fresh id
     * is always assigned so the import is additive. Returns the new
     * conversation id, or undefined when canceled/failed.
     */
    async importConversationViaDialog(): Promise<{
      conversationId?: string
      canceled: boolean
      error?: string
    }> {
      const bridge = window.agentApi
      if (!bridge?.importConversationMarkdown) {
        return { canceled: true }
      }
      const result = await bridge.importConversationMarkdown({
        version: IPC_VERSION,
      })
      if (!result.ok || result.value.canceled || !result.value.markdown) {
        return {
          canceled: true,
          error: result.ok ? undefined : result.error.message,
        }
      }

      let parsed
      try {
        parsed = markdownToConversation(result.value.markdown)
      } catch (error) {
        if (error instanceof ConversationMarkdownError) {
          return { canceled: false, error: error.message }
        }
        throw error
      }

      // Always assign a fresh id/title to avoid colliding with or overwriting
      // an existing conversation. The shared record is structurally compatible
      // with the renderer record.
      const now = new Date().toISOString()
      const imported = {
        ...(parsed as unknown as ConversationRecord),
        id: requestId(),
        title: normalizeTitle(`Imported: ${parsed.title}`).slice(
          0,
          CONVERSATION_TITLE_MAX,
        ),
        importedFrom: 'markdown',
        createdAt: now,
        updatedAt: now,
      }
      this.registerProject(imported.projectPath)
      this.conversations.push(imported)
      this.activeConversationId = imported.id
      this.persistWorkbench()
      return { conversationId: imported.id, canceled: false }
    },
    removeConversationRecord(conversationId: string) {
      this.conversations = this.conversations.filter(
        (item) => item.id !== conversationId,
      )
    },
    removeProjectRecords(workspacePath: string) {
      this.projects = this.projects.filter(
        (project) => project.path !== workspacePath,
      )
      this.conversations = this.conversations.filter(
        (conversation) => conversation.projectPath !== workspacePath,
      )
    },
    persistWorkbench() {
      const snapshot = snapshotForPersistence(this)
      const bridge = window.agentApi as unknown as WorkbenchBridge | undefined

      if (typeof bridge?.saveWorkbench === 'function') {
        void bridge
          .saveWorkbench({
            version: IPC_VERSION,
            workbench: snapshot,
          })
          .then((result) => {
            if (!result.ok) this.error = result.error.message
          })
        return
      }

      try {
        window.localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify(snapshot satisfies PersistedWorkbench),
        )
      } catch {
        // Persistence is best effort; runtime behavior remains usable.
      }
    },
    async activateWorkspace(workspacePath: string): Promise<boolean> {
      this.registerProject(workspacePath)
      const bridge = window.agentApi
      if (!bridge) {
        this.workspacePath = workspacePath
        return true
      }

      const activate = workspaceActivationQueue.then(async () => {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'workspace',
          lastOpened: workspacePath,
        })
        if (!result.ok) {
          this.error = result.error.message
          return false
        }
        this.workspacePath = workspacePath
        return true
      })
      workspaceActivationQueue = activate.then(
        () => undefined,
        () => undefined,
      )
      return activate
    },
  },
})
