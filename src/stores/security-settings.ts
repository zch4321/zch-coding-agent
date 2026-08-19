import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type { PublicConfig } from '../../shared/config/public-config'
import type { PermissionMode } from '../../shared/config/security'
import type { ConfigSection } from '../../shared/ipc/configuration'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
  YOLO_NOTICE_VERSION,
} from '../../shared/notices'
import type { UiRememberedRule } from './agent-types'
import { nowNotice, toUiRememberedRules } from './config-mapping'

interface PermissionDraft {
  defaultMode: PermissionMode
  builtinPolicies: boolean
  rememberedRules: UiRememberedRule[]
  sensitiveMode: 'off' | 'warn' | 'confirm'
  pathGlobs: string
  contentPatterns: string
}

function permissionSignature(draft: PermissionDraft): string {
  return JSON.stringify(draft)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const useSecuritySettingsStore = defineStore('security-settings', {
  state: () => ({
    error: '',
    providerNoticeVersion: '',
    traceNoticeVersion: '',
    yoloNoticeVersion: '',
    builtinPolicies: true,
    rememberedRules: [] as UiRememberedRule[],
    defaultMode: 'readonly' as PermissionMode,
    permissionForm: {
      sensitiveMode: 'confirm' as 'off' | 'warn' | 'confirm',
      pathGlobs: '',
      contentPatterns: '',
    },
    permissionSavedSignature: '',
    permissionsSaving: false,
    permissionsSaveStatus: '',
  }),
  getters: {
    providerNoticeAccepted: (state) =>
      state.providerNoticeVersion === PROVIDER_NOTICE_VERSION,
    traceNoticeAccepted: (state) =>
      state.traceNoticeVersion === TRACE_NOTICE_VERSION,
    yoloNoticeAccepted: (state) =>
      state.yoloNoticeVersion === YOLO_NOTICE_VERSION,
    permissionsDirty: (state) =>
      permissionSignature({
        defaultMode: state.defaultMode,
        builtinPolicies: state.builtinPolicies,
        rememberedRules: state.rememberedRules,
        ...state.permissionForm,
      }) !== state.permissionSavedSignature,
  },
  actions: {
    /** Hydrates privacy acknowledgements and permission policy drafts. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      const includes = (section: ConfigSection) =>
        sections.includes('all') || sections.includes(section)
      if (includes('privacy')) {
        this.providerNoticeVersion =
          config.privacy.providerNoticeAccepted?.version ?? ''
        this.traceNoticeVersion =
          config.privacy.traceNoticeAccepted?.version ?? ''
        this.yoloNoticeVersion =
          config.privacy.yoloNoticeAccepted?.version ?? ''
      }
      if (includes('permission')) {
        this.defaultMode = config.permission.defaultMode
        this.builtinPolicies = config.permission.builtinPolicies
        this.rememberedRules = toUiRememberedRules(config)
        this.permissionForm.sensitiveMode = config.permission.sensitiveData.mode
        this.permissionForm.pathGlobs =
          config.permission.sensitiveData.pathGlobs.join('\n')
        this.permissionForm.contentPatterns =
          config.permission.sensitiveData.contentPatterns.join('\n')
        this.permissionSavedSignature = permissionSignature({
          defaultMode: this.defaultMode,
          builtinPolicies: this.builtinPolicies,
          rememberedRules: this.rememberedRules,
          ...this.permissionForm,
        })
      }
    },
    /** Persists the latest permission draft without dropping concurrent edits. */
    async savePermissions() {
      const bridge = window.agentApi
      if (!bridge || this.permissionsSaving) return false
      const lines = (value: string) =>
        value
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      this.permissionsSaving = true
      this.permissionsSaveStatus = ''
      this.error = ''
      try {
        while (true) {
          const draft = cloneJson<PermissionDraft>({
            defaultMode: this.defaultMode,
            builtinPolicies: this.builtinPolicies,
            rememberedRules: this.rememberedRules,
            ...this.permissionForm,
          })
          const draftSignature = permissionSignature(draft)
          const result = await bridge.setConfig({
            version: IPC_VERSION,
            kind: 'permission',
            defaultMode: draft.defaultMode,
            builtinPolicies: draft.builtinPolicies,
            rememberedRules: draft.rememberedRules.map((rule) => ({
              ...rule,
              argConstraints: JSON.parse(rule.argConstraints),
            })),
            sensitiveData: {
              mode: draft.sensitiveMode,
              pathGlobs: lines(draft.pathGlobs),
              contentPatterns: lines(draft.contentPatterns),
            },
          })
          if (!result.ok) {
            this.error = result.error.message
            this.permissionsSaveStatus = result.error.message
            return false
          }
          this.permissionSavedSignature = draftSignature
          const currentSignature = permissionSignature({
            defaultMode: this.defaultMode,
            builtinPolicies: this.builtinPolicies,
            rememberedRules: this.rememberedRules,
            ...this.permissionForm,
          })
          if (currentSignature !== draftSignature) continue

          this.applyConfig(result.value.config, ['permission'])
          this.permissionsSaveStatus = 'saved'
          return true
        }
      } finally {
        this.permissionsSaving = false
      }
    },
    /** Removes one remembered permission rule and persists the remaining rules. */
    async removeRememberedRule(ruleId: string) {
      this.rememberedRules = this.rememberedRules.filter(
        (rule) => rule.id !== ruleId,
      )
      return this.savePermissions()
    },
    /** Records acceptance of the external Provider data notice. */
    async acceptProviderNotice(): Promise<boolean> {
      return this.acceptNotice('provider')
    },
    /** Records acceptance of local trace capture. */
    async acceptTraceNotice(): Promise<boolean> {
      return this.acceptNotice('trace')
    },
    /** Records acceptance of unrestricted permission mode. */
    async acceptYoloNotice(): Promise<boolean> {
      return this.acceptNotice('yolo')
    },
    /** Persists one versioned privacy acknowledgement. */
    async acceptNotice(
      notice: 'provider' | 'trace' | 'yolo',
    ): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge) return false
      const result = await bridge.setConfig({
        version: IPC_VERSION,
        kind: 'privacy',
        ...(notice === 'provider'
          ? { providerNoticeAccepted: nowNotice(PROVIDER_NOTICE_VERSION) }
          : notice === 'trace'
            ? { traceNoticeAccepted: nowNotice(TRACE_NOTICE_VERSION) }
            : { yoloNoticeAccepted: nowNotice(YOLO_NOTICE_VERSION) }),
      })
      if (!result.ok) {
        this.error = result.error.message
        return false
      }
      this.applyConfig(result.value.config, ['privacy'])
      return true
    },
  },
})
