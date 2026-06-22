import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PermissionMode } from '../../shared/config'
import type {
  ConversationRecord,
  PersistedWorkbench,
  ProjectRecord,
} from './agent-types'
import {
  HISTORY_KEY,
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
        title: 'New conversation',
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
      const normalized = title.trim().slice(0, 120)
      if (!conversation || !normalized) return
      conversation.title = normalized
      conversation.updatedAt = new Date().toISOString()
      this.persistWorkbench()
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
