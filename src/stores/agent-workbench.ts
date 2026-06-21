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

export const useAgentWorkbenchStore = defineStore('agent-workbench', {
  state: () => ({
    error: '',
    workspacePath: '',
    projects: [] as ProjectRecord[],
    conversations: [] as ConversationRecord[],
    activeConversationId: undefined as string | undefined,
  }),
  getters: {
    activeConversation: (state): ConversationRecord | undefined =>
      state.conversations.find(
        (conversation) => conversation.id === state.activeConversationId,
      ),
  },
  actions: {
    loadPersistedWorkbench() {
      const history = loadWorkbench()
      this.projects = history.projects
      this.conversations = history.conversations
      this.activeConversationId = history.activeConversationId
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
      try {
        window.localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify({
            projects: this.projects,
            conversations: this.conversations,
            activeConversationId: this.activeConversationId,
          } satisfies PersistedWorkbench),
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
