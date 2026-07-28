<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()
const approvalProvider = computed(() =>
  agent.providers.find(
    (provider) => provider.id === agent.approvalForm.providerId,
  ),
)
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.approvalTitle') }}</h2>
      <p>{{ t('settings.approvalHint') }}</p>
    </div>

    <label class="settings-field">
      <span>{{ t('settings.approverProvider') }}</span>
      <NSelect
        :value="agent.approvalForm.providerId"
        :options="agent.providerOptions"
        filterable
        @update:value="agent.setApprovalProvider"
      />
      <small>
        {{
          approvalProvider?.credentialConfigured
            ? t('settings.approvalCredentialReady')
            : t('settings.approvalCredentialMissing')
        }}
      </small>
    </label>

    <label class="settings-field">
      <span>{{ t('settings.approverModel') }}</span>
      <NSelect
        v-model:value="agent.approvalForm.model"
        :options="agent.approvalModelOptions"
        filterable
        tag
      />
      <small>{{ t('settings.approvalModelHint') }}</small>
    </label>

    <div class="settings-actions">
      <NButton
        type="primary"
        :loading="agent.approvalSaving"
        :disabled="!agent.approvalDirty"
        @click="agent.saveApproval"
      >
        {{ t('settings.saveApproval') }}
      </NButton>
      <small class="settings-save-status" aria-live="polite">
        {{
          agent.approvalDirty
            ? t('settings.unsaved')
            : agent.approvalSaveStatus
              ? t('settings.saved')
              : ''
        }}
      </small>
    </div>
  </section>
</template>
