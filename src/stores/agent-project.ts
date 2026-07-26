import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { IPC_VERSION } from '../../shared/channels'
import type {
  CodeBackendStatus,
  ProjectMetadataSnapshot,
  ProjectModel,
  ProjectModule,
} from '../../shared/project-model'
import { useAgentReplicaStore } from './agent-replica'

function bridge() {
  return window.agentApi
}

function activeProjectId() {
  return useAgentReplicaStore().selectedProjectId
}

export const useAgentProjectStore = defineStore('agent-project', {
  state: () => ({
    projectSnapshot: undefined as ProjectMetadataSnapshot | undefined,
    detectedModules: [] as ProjectModule[],
    backendStatuses: [] as CodeBackendStatus[],
    loading: false,
    detecting: false,
    saving: false,
    restartingBackendId: '',
    error: '',
    loadGeneration: 0,
  }),
  actions: {
    async loadProject(workspace: string) {
      const api = bridge()
      const projectId = activeProjectId()
      if (!api?.getProject || !workspace || !projectId) return
      const generation = ++this.loadGeneration
      this.loading = true
      this.error = ''
      this.projectSnapshot = undefined
      this.backendStatuses = []
      const result = await api.getProject({ version: IPC_VERSION, projectId })
      if (
        generation !== this.loadGeneration ||
        activeProjectId() !== projectId
      ) {
        if (generation === this.loadGeneration) this.loading = false
        return
      }
      this.loading = false

      if (result.ok) {
        this.projectSnapshot = result.value
        await this.loadBackendStatus(workspace, projectId, generation)
      } else {
        this.error = result.error.message
      }
    },
    async loadBackendStatus(
      workspace: string,
      projectId = activeProjectId(),
      generation?: number,
    ) {
      const api = bridge()
      if (!api?.getProjectBackendStatus || !workspace || !projectId) return
      const expectedGeneration = generation ?? this.loadGeneration
      const result = await api.getProjectBackendStatus({
        version: IPC_VERSION,
        projectId,
      })
      if (
        expectedGeneration !== this.loadGeneration ||
        activeProjectId() !== projectId
      ) {
        return
      }

      if (result.ok) this.backendStatuses = result.value.statuses
      else this.error = result.error.message
    },
    async detectModules(workspace: string) {
      const api = bridge()
      const projectId = activeProjectId()
      if (!api?.detectProjectModules || !workspace || !projectId) return
      this.detecting = true
      this.error = ''
      const result = await api.detectProjectModules({
        version: IPC_VERSION,
        projectId,
      })
      this.detecting = false

      if (result.ok) this.detectedModules = result.value.modules
      else this.error = result.error.message
    },
    async saveProject(workspace: string, project: ProjectModel) {
      const api = bridge()
      const projectId = activeProjectId()
      if (!api?.saveProject || !workspace || !projectId) return false
      this.saving = true
      this.error = ''
      const result = await api.saveProject({
        version: IPC_VERSION,
        projectId,
        project,
      })
      this.saving = false

      if (result.ok) {
        this.projectSnapshot = result.value
        await this.loadBackendStatus(workspace)
        return true
      }

      this.error = result.error.message
      return false
    },
    async useDetectedModules(workspace: string) {
      if (!this.projectSnapshot || this.detectedModules.length === 0)
        return false
      const project: ProjectModel = {
        ...structuredClone(toRaw(this.projectSnapshot.project)),
        modules: structuredClone(toRaw(this.detectedModules)),
        defaultModuleId: this.detectedModules[0]?.id,
      }
      return this.saveProject(workspace, project)
    },
    async setSerenaEnabled(workspace: string, enabled: boolean) {
      if (!this.projectSnapshot) return false
      const project: ProjectModel = structuredClone(
        toRaw(this.projectSnapshot.project),
      )
      project.serena.enabled = enabled
      project.backendBindings = project.backendBindings.map((binding) =>
        binding.backendId === project.serena.id
          ? { ...binding, enabled }
          : binding,
      )
      return this.saveProject(workspace, project)
    },
    async restartBackend(workspace: string, backendId: string) {
      const api = bridge()
      const projectId = activeProjectId()
      if (!api?.restartProjectBackend || !workspace || !projectId) return
      this.restartingBackendId = backendId
      this.error = ''
      const result = await api.restartProjectBackend({
        version: IPC_VERSION,
        projectId,
        backendId,
      })
      this.restartingBackendId = ''

      if (result.ok) {
        const others = this.backendStatuses.filter(
          (status) => status.backendId !== result.value.backendId,
        )
        this.backendStatuses = [...others, result.value]
      } else {
        this.error = result.error.message
      }
    },
  },
})
