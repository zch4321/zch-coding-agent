<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NInputNumber, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()
const reasoningOptions = computed(() => [
  { label: t('settings.reasoningOff'), value: 'off' },
  { label: t('settings.reasoningHigh'), value: 'high' },
  { label: t('settings.reasoningMax'), value: 'max' },
])
const tokenEstimationOptions = computed(() => [
  { label: t('settings.tokenConservative'), value: 'conservative' },
  { label: t('settings.tokenCustom'), value: 'custom-bytes' },
])
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.providerTitle') }}</h2>
      <p>{{ t('settings.providerHint') }}</p>
    </div>
    <label class="settings-field">
      <span>{{ t('settings.baseUrl') }}</span>
      <NInput v-model:value="agent.providerForm.baseURL" />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.mainModel') }}</span>
      <div class="settings-inline">
        <NSelect
          :value="agent.providerForm.model"
          :options="agent.modelOptions"
          :loading="agent.modelCatalogLoading"
          filterable
          tag
          @update:value="agent.setProviderModel"
        />
        <NButton
          secondary
          :loading="agent.modelCatalogLoading"
          :disabled="!agent.credentialConfigured"
          @click="agent.loadProviderModels(true)"
        >
          {{ t('common.refresh') }}
        </NButton>
      </div>
      <small>
        {{
          agent.activeModelProfile
            ? t('settings.modelProfile', {
                availability: agent.activeModelProfile.availability,
                source: agent.activeModelProfile.capabilitySource,
                tokens:
                  agent.activeModelProfile.contextWindowTokens.toLocaleString(),
              })
            : t('settings.customModel')
        }}
      </small>
    </label>
    <div class="settings-inline settings-inline-equal">
      <label class="settings-field">
        <span>{{ t('settings.contextOverride') }}</span>
        <NInputNumber
          v-model:value="agent.providerForm.contextWindowTokens"
          :min="1024"
          :max="10000000"
          clearable
          :placeholder="t('settings.useDefault')"
        />
      </label>
      <label class="settings-field">
        <span>{{ t('settings.outputOverride') }}</span>
        <NInputNumber
          v-model:value="agent.providerForm.maxOutputTokens"
          :min="1"
          :max="10000000"
          clearable
          :placeholder="t('settings.useDefault')"
        />
      </label>
    </div>
    <div class="settings-inline settings-inline-equal">
      <label class="settings-field">
        <span>{{ t('settings.tokenEstimation') }}</span>
        <NSelect
          v-model:value="agent.providerForm.tokenEstimationMode"
          :options="tokenEstimationOptions"
        />
      </label>
      <label class="settings-field">
        <span>{{ t('settings.bytesPerToken') }}</span>
        <NInputNumber
          v-model:value="agent.providerForm.bytesPerToken"
          :disabled="agent.providerForm.tokenEstimationMode !== 'custom-bytes'"
          :min="0.25"
          :max="32"
          :step="0.25"
        />
      </label>
    </div>
    <p class="settings-footnote">
      {{ t('settings.tokenHint') }}
    </p>
    <label class="settings-field">
      <span>{{ t('settings.reasoning') }}</span>
      <NSelect
        v-model:value="agent.providerForm.reasoning"
        :options="reasoningOptions"
      />
      <small>
        {{ t('settings.reasoningHint') }}
      </small>
    </label>
    <label class="settings-field">
      <span>{{ t('settings.approverModel') }}</span>
      <NSelect
        v-model:value="agent.providerForm.approverModel"
        :options="agent.modelOptions"
        filterable
        tag
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.apiKey') }}</span>
      <NInput
        v-model:value="agent.providerForm.apiKey"
        type="password"
        show-password-on="click"
        :placeholder="t('settings.apiKeyPlaceholder')"
      />
      <small>
        {{
          agent.credentialConfigured
            ? agent.credentialSource === 'environment'
              ? t('settings.credentialEnv')
              : t('settings.credentialStored')
            : t('settings.credentialNone')
        }}
      </small>
    </label>
    <div class="settings-actions">
      <NButton
        type="primary"
        :loading="agent.providerSaving"
        :disabled="!agent.providerDirty"
        @click="agent.saveProvider"
      >
        {{ t('settings.saveProvider') }}
      </NButton>
      <NButton
        v-if="agent.credentialSource === 'safe-storage'"
        secondary
        @click="agent.clearCredential"
      >
        {{ t('settings.clearCredential') }}
      </NButton>
      <small class="settings-save-status" aria-live="polite">
        {{
          agent.providerDirty
            ? t('settings.unsaved')
            : agent.providerSaveStatus
              ? t('settings.saved')
              : ''
        }}
      </small>
    </div>
  </section>
</template>
