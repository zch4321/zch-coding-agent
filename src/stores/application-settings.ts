import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { useSecuritySettingsStore } from './security-settings'

export const useApplicationSettingsStore = defineStore('application-settings', {
  state: () => ({
    error: '',
    loggingForm: {
      enabled: false,
      retentionDays: 14,
      maxTotalMegabytes: 100,
    },
    loggingWarnings: [] as string[],
  }),
  actions: {
    /** Hydrates logging and trace retention controls from public config. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('logging')) return
      this.loggingForm.enabled = config.logging.enabled
      this.loggingForm.retentionDays = config.logging.retentionDays
      this.loggingForm.maxTotalMegabytes = Math.max(
        1,
        Math.round(config.logging.maxTotalBytes / 1_000_000),
      )
    },
    /** Persists logging controls after obtaining trace acknowledgement. */
    async saveLogging() {
      const bridge = window.agentApi
      if (!bridge) return
      const security = useSecuritySettingsStore()
      if (
        this.loggingForm.enabled &&
        !security.traceNoticeAccepted &&
        !(await security.acceptTraceNotice())
      ) {
        this.error = security.error
        return
      }

      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'logging',
        value: {
          enabled: this.loggingForm.enabled,
          retentionDays: Math.max(1, this.loggingForm.retentionDays),
          maxTotalBytes: Math.max(
            1_024,
            Math.round(this.loggingForm.maxTotalMegabytes * 1_000_000),
          ),
        },
      })
      if (result.ok) {
        this.applyConfig(result.value.config, ['logging'])
        this.loggingWarnings = [...(result.value.warnings ?? [])]
      } else {
        this.error = result.error.message
      }
    },
  },
})
