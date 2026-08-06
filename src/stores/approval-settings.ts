import { defineStore } from 'pinia'
import { IPC_VERSION } from '../../shared/channels'
import type {
  ConfigSection,
  ProviderPublicConfig,
  PublicConfig,
  ReasoningEffort,
} from '../../shared/config'

interface ApprovalForm {
  providerId: string
  model: string
  reasoning: ReasoningEffort
}

const DEFAULT_APPROVAL_FORM: ApprovalForm = {
  providerId: 'deepseek',
  model: '',
  reasoning: 'high',
}

function approvalSignature(form: ApprovalForm): string {
  return JSON.stringify(form)
}

export const useApprovalSettingsStore = defineStore('approval-settings', {
  state: () => ({
    error: '',
    approvalForm: structuredClone(DEFAULT_APPROVAL_FORM),
    approvalSavedForm: structuredClone(DEFAULT_APPROVAL_FORM),
    approvalSavedSignature: approvalSignature(DEFAULT_APPROVAL_FORM),
    approvalSaving: false,
    approvalSaveStatus: '',
  }),
  getters: {
    approvalDirty: (state) =>
      approvalSignature(state.approvalForm) !== state.approvalSavedSignature,
  },
  actions: {
    /** Hydrates the saved approval route without coupling it to Provider drafts. */
    applyConfig(config: PublicConfig, sections: ConfigSection[] = ['all']) {
      if (!sections.includes('all') && !sections.includes('approval')) return

      const savedApproval: ApprovalForm = {
        providerId: config.approval.approverProviderId,
        model: config.approval.approverModel,
        reasoning: config.approval.reasoning,
      }
      this.approvalForm = structuredClone(savedApproval)
      this.approvalSavedForm = structuredClone(savedApproval)
      this.approvalSavedSignature = approvalSignature(savedApproval)
    },
    /** Selects a Provider and its first enabled model while preserving reasoning. */
    selectProvider(
      provider: Pick<ProviderPublicConfig, 'id' | 'enabledModelIds'>,
    ) {
      this.approvalForm.providerId = provider.id
      this.approvalForm.model = provider.enabledModelIds[0] ?? ''
      this.approvalSaveStatus = ''
    },
    /** Persists the complete approval route, including its explicit reasoning. */
    async saveApproval(): Promise<boolean> {
      const bridge = window.agentApi
      if (!bridge || this.approvalSaving) return false

      this.error = ''
      this.approvalSaving = true
      this.approvalSaveStatus = ''
      try {
        const result = await bridge.setConfig({
          version: IPC_VERSION,
          kind: 'approval',
          approverProviderId: this.approvalForm.providerId,
          approverModel: this.approvalForm.model,
          reasoning: this.approvalForm.reasoning,
        })
        if (!result.ok) {
          this.error = result.error.message
          return false
        }
        this.applyConfig(result.value.config, ['approval'])
        this.approvalSaveStatus = 'saved'
        return true
      } finally {
        this.approvalSaving = false
      }
    },
  },
})
