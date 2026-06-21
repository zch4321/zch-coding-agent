import { defineStore } from 'pinia'
import type { FileChangeRecord } from '../../shared/change-history'
import { IPC_VERSION } from '../../shared/channels'
import { useAgentWorkbenchStore } from './agent-workbench'

export const useAgentChangesStore = defineStore('agent-changes', {
  state: () => ({
    error: '',
    changes: [] as FileChangeRecord[],
    changesLoading: false,
    revertingChangeId: undefined as string | undefined,
    workspaceFileRevision: 0,
  }),
  actions: {
    reset() {
      this.changes = []
      this.changesLoading = false
      this.revertingChangeId = undefined
    },
    async loadConversationChanges() {
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const conversationId = workbench.activeConversationId
      const workspace = workbench.workspacePath

      if (!bridge || !conversationId || !workspace) {
        this.changes = []
        return
      }

      this.changesLoading = true
      const result = await bridge.listChanges({
        version: IPC_VERSION,
        conversationId,
        workspace,
      })
      this.changesLoading = false

      if (
        conversationId !== workbench.activeConversationId ||
        workspace !== workbench.workspacePath
      ) {
        return
      }

      if (result.ok) this.changes = result.value.changes
      else this.error = result.error.message
    },
    async revertChange(changeId: string, blocked = false) {
      const workbench = useAgentWorkbenchStore()
      const bridge = window.agentApi
      const conversationId = workbench.activeConversationId
      const workspace = workbench.workspacePath

      if (
        !bridge ||
        !conversationId ||
        !workspace ||
        blocked ||
        this.revertingChangeId
      ) {
        return false
      }

      this.revertingChangeId = changeId
      const result = await bridge.revertChange({
        version: IPC_VERSION,
        id: changeId,
        conversationId,
        workspace,
      })
      this.revertingChangeId = undefined

      if (!result.ok) {
        this.error = result.error.message
        return false
      }

      this.changes = this.changes.map((change) =>
        change.id === result.value.change.id ? result.value.change : change,
      )
      this.workspaceFileRevision += 1
      return true
    },
  },
})
