<script setup lang="ts">
import { NButton, NInput, NInputNumber, NSelect } from 'naive-ui'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const reasoningOptions = [
  { label: 'Automatic', value: 'auto' },
  { label: 'Off', value: 'off' },
]
const tokenEstimationOptions = [
  { label: 'Conservative default', value: 'conservative' },
  { label: 'Custom UTF-8 bytes/token', value: 'custom-bytes' },
]
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>Provider</h2>
      <p>Configure the main model and the Auto approval model.</p>
    </div>
    <label class="settings-field">
      <span>Base URL</span>
      <NInput v-model:value="agent.providerForm.baseURL" />
    </label>
    <label class="settings-field">
      <span>Main model</span>
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
          Refresh
        </NButton>
      </div>
      <small>
        {{
          agent.activeModelProfile
            ? agent.activeModelProfile.availability +
              ' model · ' +
              agent.activeModelProfile.capabilitySource +
              ' capabilities · ' +
              agent.activeModelProfile.contextWindowTokens.toLocaleString() +
              ' effective context tokens'
            : 'Custom model with conservative capability defaults.'
        }}
      </small>
    </label>
    <div class="settings-inline settings-inline-equal">
      <label class="settings-field">
        <span>Context window override</span>
        <NInputNumber
          v-model:value="agent.providerForm.contextWindowTokens"
          :min="1024"
          :max="10000000"
          clearable
          placeholder="Use model/default value"
        />
      </label>
      <label class="settings-field">
        <span>Maximum output override</span>
        <NInputNumber
          v-model:value="agent.providerForm.maxOutputTokens"
          :min="1"
          :max="10000000"
          clearable
          placeholder="Use model/default value"
        />
      </label>
    </div>
    <div class="settings-inline settings-inline-equal">
      <label class="settings-field">
        <span>Token estimation</span>
        <NSelect
          v-model:value="agent.providerForm.tokenEstimationMode"
          :options="tokenEstimationOptions"
        />
      </label>
      <label class="settings-field">
        <span>UTF-8 bytes per token</span>
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
      Token estimation plans context usage. Byte, line and result limits remain
      enforced independently.
    </p>
    <label class="settings-field">
      <span>Reasoning</span>
      <NSelect
        v-model:value="agent.providerForm.reasoning"
        :options="reasoningOptions"
      />
    </label>
    <label class="settings-field">
      <span>Auto approver model</span>
      <NSelect
        v-model:value="agent.providerForm.approverModel"
        :options="agent.modelOptions"
        filterable
        tag
      />
    </label>
    <label class="settings-field">
      <span>API key</span>
      <NInput
        v-model:value="agent.providerForm.apiKey"
        type="password"
        show-password-on="click"
        placeholder="Enter a new key"
      />
      <small>
        {{
          agent.credentialConfigured
            ? agent.credentialSource === 'environment'
              ? 'Using DEEPSEEK_API_KEY from the main-process environment.'
              : 'A credential is stored securely.'
            : 'No credential is configured.'
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
        Save provider
      </NButton>
      <NButton
        v-if="agent.credentialSource === 'safe-storage'"
        secondary
        @click="agent.clearCredential"
      >
        Clear credential
      </NButton>
      <small class="settings-save-status" aria-live="polite">
        {{ agent.providerDirty ? 'Unsaved changes' : agent.providerSaveStatus }}
      </small>
    </div>
  </section>
</template>
