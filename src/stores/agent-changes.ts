import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { FileChangeId } from '../../shared/ids'
import { useAgentReplicaStore } from './agent-replica'

export const useAgentChangesStore = defineStore('agent-changes', {
  state: () => ({
    changesLoading: false,
    revertingChangeId: '',
    error: '',
  }),
  getters: {
    changes: () => useAgentReplicaStore().selectedFileChanges,
  },
  actions: {
    async loadConversationChanges() {
      this.changesLoading = true
      await useAgentReplicaStore().loadFileChanges()
      this.changesLoading = false
    },
    async revertChange(changeId: string, runBusy = false) {
      const replica = useAgentReplicaStore()
      const session = replica.selectedSession
      const change = replica.selectedFileChanges.find(
        (candidate) => candidate.id === changeId,
      )
      if (!window.agentApi || !session || !change || runBusy) return false
      this.revertingChangeId = changeId
      const result = await window.agentApi.revertFileChange({
        version: IPC_VERSION,
        sessionId: session.id,
        fileChangeId: change.id as FileChangeId,
        expectedRevision: change.revision,
      })
      this.revertingChangeId = ''
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      await replica.reconcile(result.value.commit)
      return true
    },
  },
})
