import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { SkillDiagnostic, SkillSummary } from '../../shared/skills'

export const useSkillsStore = defineStore('skills', {
  state: () => ({
    items: [] as SkillSummary[],
    diagnostics: [] as SkillDiagnostic[],
    url: '',
    loading: false,
    error: '',
  }),
  actions: {
    apply(value: { skills: SkillSummary[]; diagnostics: SkillDiagnostic[] }) {
      this.items = value.skills
      this.diagnostics = value.diagnostics
    },
    async load(refresh = false) {
      const bridge = window.agentApi
      if (!bridge || this.loading) return
      this.loading = true
      this.error = ''
      try {
        const result = refresh
          ? await bridge.refreshSkills({ version: IPC_VERSION })
          : await bridge.listSkills({ version: IPC_VERSION })
        if (result.ok) this.apply(result.value)
        else this.error = result.error.message
      } finally {
        this.loading = false
      }
    },
    async installFromUrl() {
      const bridge = window.agentApi
      const url = this.url.trim()
      if (!bridge || !url || this.loading) return
      this.loading = true
      this.error = ''
      try {
        const result = await bridge.installSkillFromUrl({
          version: IPC_VERSION,
          url,
        })
        if (!result.ok) {
          this.error = result.error.message
          return
        }
        this.url = ''
      } finally {
        this.loading = false
      }
      await this.load(true)
    },
    async chooseAndInstall() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.chooseAndInstallSkill({
        version: IPC_VERSION,
      })
      if (result.ok && result.value.installed) await this.load(true)
      else if (!result.ok) this.error = result.error.message
    },
    async setEnabled(name: string, enabled: boolean) {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.setSkillEnabled({
        version: IPC_VERSION,
        name,
        enabled,
      })
      if (result.ok && result.value.updated) await this.load(false)
      else if (!result.ok) this.error = result.error.message
    },
  },
})
