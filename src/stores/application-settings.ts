import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { ConfigSection } from '../../shared/ipc/configuration'
import { useSecuritySettingsStore } from './security-settings'

export const useApplicationSettingsStore = defineStore('application-settings', {
  state: () => ({
    error: '',
    loggingForm: {
      operational: {
        level: 'info' as 'off' | 'error' | 'warn' | 'info' | 'debug',
        retentionDays: 14,
        maxTotalMegabytes: 50,
      },
      trace: {
        enabled: false,
        retentionDays: 14,
        maxTotalMegabytes: 500,
      },
    },
    loggingWarnings: [] as string[],
    runtimeLogStatus: undefined as
      | {
          enabled: boolean
          level: 'off' | 'error' | 'warn' | 'info' | 'debug'
          degraded: boolean
          warning?: string
        }
      | undefined,
    runtimeLogActionMessage: '',
  }),
  actions: {
    /** Hydrates logging and trace retention controls from public config. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('logging')) return
      this.loggingForm.operational.level = config.logging.operational.level
      this.loggingForm.operational.retentionDays =
        config.logging.operational.retentionDays
      this.loggingForm.operational.maxTotalMegabytes = Math.max(
        1,
        Math.round(config.logging.operational.maxTotalBytes / 1_000_000),
      )
      this.loggingForm.trace.enabled = config.logging.trace.enabled
      this.loggingForm.trace.retentionDays = config.logging.trace.retentionDays
      this.loggingForm.trace.maxTotalMegabytes = Math.max(
        1,
        Math.round(config.logging.trace.maxTotalBytes / 1_000_000),
      )
    },
    /** Persists logging controls after obtaining trace acknowledgement. */
    async saveLogging() {
      const bridge = window.agentApi
      if (!bridge) return
      const security = useSecuritySettingsStore()
      if (
        this.loggingForm.trace.enabled &&
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
          operational: {
            level: this.loggingForm.operational.level,
            retentionDays: Math.max(
              1,
              this.loggingForm.operational.retentionDays,
            ),
            maxTotalBytes: Math.max(
              1_024,
              Math.round(
                this.loggingForm.operational.maxTotalMegabytes * 1_000_000,
              ),
            ),
          },
          trace: {
            enabled: this.loggingForm.trace.enabled,
            retentionDays: Math.max(1, this.loggingForm.trace.retentionDays),
            maxTotalBytes: Math.max(
              1_024,
              Math.round(this.loggingForm.trace.maxTotalMegabytes * 1_000_000),
            ),
          },
        },
      })
      if (result.ok) {
        this.applyConfig(result.value.config, ['logging'])
        this.loggingWarnings = [...(result.value.warnings ?? [])]
        await this.loadRuntimeLogStatus()
      } else {
        this.error = result.error.message
      }
    },
    /** Refreshes operational logging availability and degraded state. */
    async loadRuntimeLogStatus() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.getRuntimeLogStatus({ version: IPC_VERSION })
      if (result.ok) this.runtimeLogStatus = result.value
      else this.error = result.error.message
    },
    /** Opens the operational runtime-log directory. */
    async openRuntimeLogDirectory() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.openRuntimeLogDirectory({
        version: IPC_VERSION,
      })
      if (!result.ok) this.error = result.error.message
    },
    /** Clears rotated operational logs while preserving the active file. */
    async clearRuntimeLogs() {
      const bridge = window.agentApi
      if (!bridge) return
      const result = await bridge.clearRuntimeLogs({ version: IPC_VERSION })
      if (result.ok) {
        this.runtimeLogActionMessage = `${result.value.deleted}`
        await this.loadRuntimeLogStatus()
      } else {
        this.error = result.error.message
      }
    },
  },
})
